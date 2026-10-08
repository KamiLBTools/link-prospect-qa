#!/bin/zsh
# Overnight, unattended: finish the paid QA run, crawl the unfetched sites with
# the new fetcher, queue the newly English ones, and QA the combined list.
# Every step resumes, so a restart never pays twice. Progress: qa/overnight.log
cd /Users/kamiturky/Desktop/SEOTools/QA
LOG=qa/overnight.log
say() { echo "[$(date '+%H:%M:%S')] $*" >> $LOG; }

ENGLISH=qa/lang-check/selection-2026-10-02-final-english.txt
OUT=qa/selection-results.csv

# A QA run, restarted until it writes its rows (at most 5 tries).
qa_until_done() {
  local list=$1 runlog=$2
  for try in 1 2 3 4 5; do
    say "QA run on $list, try $try"
    QA_OUT=$OUT npm run qa -- $list --run >> $runlog 2>&1
    if tail -20 $runlog | grep -q "rows written to"; then say "QA run finished: $(tail -20 $runlog | grep 'rows written')"; return 0; fi
    say "ERROR: QA run stopped without writing rows; restarting"
    sleep 60
  done
  say "FATAL: QA run failed 5 times"; return 1
}

say "START"

# 1. The paid run already in progress: wait for it, then make sure it finished.
while pgrep -f "src/qa/run.ts" > /dev/null; do sleep 60; done
if tail -20 qa/selection-run.log | grep -q "rows written to"; then
  say "First paid run finished: $(tail -20 qa/selection-run.log | grep 'rows written')"
else
  say "ERROR: first paid run ended early; resuming it"
  qa_until_done $ENGLISH qa/selection-run.log || exit 1
fi

# 2. Crawl the unfetched sites with the www/http fallback and the browser render.
python3 - <<'EOF'
import csv
rows=[r for r in csv.DictReader(open("qa/lang-check/selection-2026-10-02-final.csv")) if r["Result"]=="unfetched"]
open("qa/lists/selection-2026-10-02-recrawl.txt","w").write("\n".join(r["Website"] for r in rows)+"\n")
EOF
say "Recrawling $(wc -l < qa/lists/selection-2026-10-02-recrawl.txt) unfetched sites"
for try in 1 2 3; do
  FETCH_TIMEOUT_MS=30000 FETCH_CONCURRENCY=12 npm run lang-check -- qa/lists/selection-2026-10-02-recrawl.txt --tiebreak >> qa/selection-recrawl.log 2>&1 && break
  say "ERROR: recrawl stopped (try $try); resuming"
  sleep 30
done
[ -f qa/lang-check/selection-2026-10-02-recrawl.csv ] || { say "FATAL: recrawl never finished"; exit 1; }
say "Recrawl done: $(tail -5 qa/selection-recrawl.log | tr '\n' ' ')"

# 3. Merge, queue the new English sites with the sheet's fields, QA everything.
python3 - <<'EOF' >> qa/overnight.log
import csv
final={x["Website"]:x for x in csv.DictReader(open("qa/lang-check/selection-2026-10-02-final.csv"))}
for x in csv.DictReader(open("qa/lang-check/selection-2026-10-02-recrawl.csv")): final[x["Website"]]=x
order=["english","check","unfetched","other"]
rows=sorted(final.values(),key=lambda r:(order.index(r["Result"]),r["Website"]))
w=csv.writer(open("qa/lang-check/selection-2026-10-02-final.csv","w",newline=""))
w.writerow(["Website","Result","Page Tag","Detected","Model","Error"])
for r in rows: w.writerow([r["Website"],r["Result"],r["Page Tag"],r["Detected"],r.get("Model",""),r["Error"]])
english=[r["Website"] for r in rows if r["Result"]=="english"]
open("qa/lang-check/selection-2026-10-02-final-english.txt","w").write("\n".join(english)+"\n")

src={x["website"].strip().lower():x for x in csv.DictReader(open("/Users/kamiturky/Downloads/selection-2026-10-02.csv",encoding="utf-8-sig"))}
out=list(csv.DictReader(open("qa/selection-results.csv")))
header=list(out[0].keys())
have={r["Website"] for r in out}
new=[d for d in english if d not in have and d in src]
with open("qa/selection-results.csv","a",newline="") as f:
    w=csv.DictWriter(f,fieldnames=header)
    for d in new:
        s=src[d]
        w.writerow({"Website":d,"Normal":s["normal_price"],"Grey":s["grey_niche"],"Insertion":s["insertion"],"Email":s["email"],"Relationship":s["relationship"]})
print(f"[merge] english now {len(english)}, newly queued {len(new)}")
EOF
qa_until_done $ENGLISH qa/selection-run-2.log || exit 1
say "DONE"
