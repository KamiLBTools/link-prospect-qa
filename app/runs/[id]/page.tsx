import { notFound } from "next/navigation";
import { db } from "../../../src/db/client";
import { getRun, listSites } from "../../../src/db/queries";
import { VERDICTS } from "../../../src/domain/verdict";
import { saveHumanVerdict } from "../../actions";

export const dynamic = "force-dynamic";

export default async function RunPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await props.params;
  const search = await props.searchParams;

  const run = await getRun(db, id);
  if (!run) notFound();

  const first = (key: string) => {
    const value = search[key];
    const text = Array.isArray(value) ? value[0] : value;
    return text?.trim() || undefined;
  };

  const rows = await listSites(db, id, {
    verdict: first("verdict"),
    status: first("status"),
    q: first("q"),
  });

  return (
    <>
      <div className="pagehead">
        <h1>{run.label ?? `Run ${run.id.slice(0, 8)}`}</h1>
        <p className="sub">
          <span className={`pill ${run.stage === "failed" ? "bad" : run.stage === "done" ? "ok" : "warn"}`}>
            {run.stage}
          </span>{" "}
          {run.inputCount} domains · {run.ahrefsUnits.toLocaleString("en-US")} Ahrefs
          units · DR ≥ {run.thresholds.minDomainRating}, traffic ≥{" "}
          {run.thresholds.minOrganicTraffic}, keywords ≥{" "}
          {run.thresholds.minOrganicKeywords}, out/in ≤ {run.thresholds.maxOutInRatio}
        </p>
      </div>

      <div className="toolbar">
        <form method="get">
          <input name="q" placeholder="Search domain" defaultValue={first("q") ?? ""} className="search" />
          <select name="verdict" defaultValue={first("verdict") ?? ""}>
            <option value="">Any verdict</option>
            {VERDICTS.map((verdict) => (
              <option key={verdict} value={verdict}>{verdict}</option>
            ))}
          </select>
          <select name="status" defaultValue={first("status") ?? ""}>
            <option value="">Any status</option>
            {["done", "prefail", "error", "pending"].map((status) => (
              <option key={status} value={status}>{status}</option>
            ))}
          </select>
          <button type="submit">Filter</button>
        </form>
        <span className="spacer" style={{ flex: 1 }} />
        <a href={`/qa/api/export?run=${run.id}`}>Export CSV</a>
      </div>

      {run.rejectedInputs && run.rejectedInputs.length > 0 && (
        <p className="banner">
          {run.rejectedInputs.length} input lines were not usable domains and
          were dropped: {run.rejectedInputs.slice(0, 5).map((r) => r.input).join(", ")}
          {run.rejectedInputs.length > 5 ? " …" : ""}
        </p>
      )}

      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Domain</th>
              <th>Verdict</th>
              <th>DR</th>
              <th>Traffic</th>
              <th>Kws</th>
              <th>Out/in</th>
              <th>Brand</th>
              <th>Why</th>
              <th>Your call</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((site) => (
              <tr key={site.id}>
                <td>
                  <a href={`https://${site.domain}`} target="_blank" rel="noreferrer">
                    {site.domain}
                  </a>
                  {site.siteType && <div className="dim">{site.siteType}</div>}
                </td>

                <td>
                  {site.verdict ? (
                    <span className={`pill v-${site.verdict}`}>{site.verdict}</span>
                  ) : (
                    <span className={`pill v-prefail`}>{site.status}</span>
                  )}
                  {site.nichePenaltyApplied && (
                    <div className="dim" title="Demoted one step for niche mismatch">
                      was {site.rawVerdict}
                    </div>
                  )}
                </td>

                <td>{site.domainRating ?? "—"}</td>
                <td>{site.organicTraffic?.toLocaleString("en-US") ?? "—"}</td>
                <td>{site.organicKeywords?.toLocaleString("en-US") ?? "—"}</td>
                <td>{site.outInRatio ?? "—"}</td>
                <td>
                  {site.brandedShare === null
                    ? "—"
                    : `${Math.round(Number(site.brandedShare) * 100)}%`}
                  {site.ranksForAlmostNothing && (
                    <div className="found" title="Total top-10 coverage and fewer than 10 ranking pages">
                      ranks for ~nothing
                    </div>
                  )}
                </td>

                <td className="reason">
                  {site.prefailReason ?? site.fetchError ?? site.error ?? site.reason}
                  {site.entityRecognition === "recognised" && site.entityNote && (
                    <div className="kw">known: {site.entityNote}</div>
                  )}
                  {site.description && (
                    <div className="kw">{site.description}</div>
                  )}
                </td>

                <td className="actions">
                  <form action={saveHumanVerdict}>
                    <input type="hidden" name="siteId" value={site.id} />
                    <input type="hidden" name="runId" value={run.id} />
                    <select name="humanVerdict" defaultValue={site.humanVerdict ?? ""}>
                      <option value="">—</option>
                      {VERDICTS.map((verdict) => (
                        <option key={verdict} value={verdict}>{verdict}</option>
                      ))}
                    </select>
                    <input
                      name="humanReason"
                      placeholder="why"
                      defaultValue={site.humanReason ?? ""}
                      style={{ width: "9rem" }}
                    />
                    <button type="submit" className="link">Save</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length === 0 && <p className="empty">Nothing matches that filter.</p>}
    </>
  );
}
