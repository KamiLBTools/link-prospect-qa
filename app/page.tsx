import { db } from "../src/db/client";
import { listRuns } from "../src/db/queries";
import { DEFAULT_THRESHOLDS } from "../src/domain/gate";
import { startRun } from "./actions";

export const dynamic = "force-dynamic";

export default async function RunsPage() {
  const runs = await listRuns(db);

  return (
    <>
      <div className="pagehead">
        <h1>Runs</h1>
        <p className="sub">
          Paste a list of domains. Anything that clears the gate gets read,
          measured and judged.
        </p>
      </div>

      <form className="newrun" action={startRun}>
        <textarea
          name="domains"
          placeholder={"example.com\nhttps://www.another.com/some/page\nthird.co.uk"}
          required
        />
        <div className="row">
          <input name="label" placeholder="Name this run (optional)" />
          <span className="spacer" style={{ flex: 1 }} />
          <button type="submit">Start run</button>
        </div>
        <details style={{ marginTop: ".75rem" }}>
          <summary className="dim">Gate thresholds</summary>
          <div className="row">
            <Threshold name="minDomainRating" label="Min DR" value={DEFAULT_THRESHOLDS.minDomainRating} />
            <Threshold name="minOrganicTraffic" label="Min traffic" value={DEFAULT_THRESHOLDS.minOrganicTraffic} />
            <Threshold name="minOrganicKeywords" label="Min keywords" value={DEFAULT_THRESHOLDS.minOrganicKeywords} />
            <Threshold name="maxOutInRatio" label="Max out/in" value={DEFAULT_THRESHOLDS.maxOutInRatio} />
          </div>
          <p className="dim" style={{ marginTop: ".5rem" }}>
            Saved with the run, so its verdicts stay explainable if you change
            these later.
          </p>
        </details>
      </form>

      {runs.length === 0 ? (
        <p className="empty">No runs yet.</p>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Stage</th>
                <th>Domains</th>
                <th>Usable</th>
                <th>Prefailed</th>
                <th>Errors</th>
                <th>Ahrefs units</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td>
                    <a href={`/qa/runs/${run.id}`}>
                      {run.label ?? run.id.slice(0, 8)}
                    </a>
                    {run.error && <div className="found">{run.error}</div>}
                  </td>
                  <td className="stage">
                    <span className={`pill ${run.stage === "failed" ? "bad" : run.stage === "done" ? "ok" : "warn"}`}>
                      {run.stage}
                    </span>
                  </td>
                  <td>{run.inputCount}</td>
                  <td>{Number(run.usable)}</td>
                  <td>{Number(run.prefailed)}</td>
                  <td>{Number(run.errored) || ""}</td>
                  <td>{run.ahrefsUnits.toLocaleString("en-US")}</td>
                  <td className="date">
                    {run.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Threshold({ name, label, value }: { name: string; label: string; value: number }) {
  return (
    <label className="dim">
      {label}{" "}
      <input name={name} type="number" defaultValue={value} step="any" style={{ width: "6rem" }} />
    </label>
  );
}
