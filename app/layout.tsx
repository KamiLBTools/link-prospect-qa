import type { ReactNode } from "react";
import { Nav } from "./nav";

export const metadata = {
  title: "Link Prospect QA",
  description: "Decides whether a website is worth buying a backlink on",
};

/* Shared verbatim with Link Monitoring (../index): the two tools sit behind one
   proxy under one login and should read as one product. */
const css = `
  *, *::before, *::after { box-sizing: border-box; }

  :root {
    --bg: #f6f7f9;
    --surface: #fff;
    --line: #e3e5e9;
    --line-soft: #f0f1f4;
    --ink: #16181d;
    --ink-dim: #6b7280;
    --accent: #2563eb;
    --ok-bg: #dcfce7;    --ok-ink: #14663a;
    --bad-bg: #fee2e2;   --bad-ink: #991b1b;
    --warn-bg: #fef3c7;  --warn-ink: #92400e;
    --mute-bg: #f1f2f4;  --mute-ink: #52525b;
    --radius: 8px;
  }

  body { margin: 0; color: var(--ink); background: var(--bg);
         font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
         -webkit-font-smoothing: antialiased; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* ---------- chrome ---------- */
  nav { display: flex; gap: .25rem; align-items: center; padding: 0 1.5rem;
        background: var(--surface); border-bottom: 1px solid var(--line);
        position: sticky; top: 0; z-index: 20; }
  nav .brand { font-weight: 650; margin-right: 1.25rem; letter-spacing: -.01em; }
  nav a { padding: .85rem .75rem; color: var(--ink-dim); font-weight: 500;
          border-bottom: 2px solid transparent; margin-bottom: -1px; }
  nav a:hover { color: var(--ink); text-decoration: none; }
  nav a.on { color: var(--ink); border-bottom-color: var(--accent); }

  main { padding: 1.5rem; max-width: 1500px; }
  .pagehead { margin-bottom: 1.25rem; }
  h1 { font-size: 1.4rem; margin: 0; letter-spacing: -.02em; }
  .sub { margin: .3rem 0 0; color: var(--ink-dim); }
  .dim { color: var(--ink-dim); font-size: .8rem; }
  .note { margin-top: .75rem; }

  /* ---------- stat cards ---------- */
  .cards { display: grid; gap: .7rem; margin-bottom: 1.5rem;
           grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr)); }
  .card { display: block; background: var(--surface); border: 1px solid var(--line);
          border-radius: var(--radius); padding: .85rem 1rem; color: inherit;
          transition: border-color .12s, transform .12s, box-shadow .12s; }
  .card:hover { text-decoration: none; border-color: #c7cad1; transform: translateY(-1px);
                box-shadow: 0 2px 8px rgb(16 24 40 / .06); }
  .card .n { font-size: 1.65rem; font-weight: 650; letter-spacing: -.02em;
             line-height: 1.15; }
  .card .l { font-size: .72rem; color: var(--ink-dim); text-transform: uppercase;
             letter-spacing: .05em; font-weight: 600; margin-top: .15rem; }
  .card.bad { border-color: #fca5a5; background: #fff7f7; }
  .card.bad .n { color: var(--bad-ink); }
  .card.ok .n { color: var(--ok-ink); }

  /* ---------- filter bar ---------- */
  .filterbar { background: var(--surface); border: 1px solid var(--line);
               border-radius: var(--radius); margin-bottom: 1rem; }
  .tabs { display: flex; gap: .15rem; padding: .4rem .5rem 0; overflow-x: auto;
          border-bottom: 1px solid var(--line); }
  .tab { display: inline-flex; align-items: center; gap: .4rem; white-space: nowrap;
         padding: .5rem .75rem; border-radius: 6px 6px 0 0; color: var(--ink-dim);
         font-weight: 500; border-bottom: 2px solid transparent; margin-bottom: -1px; }
  .tab:hover { background: var(--line-soft); color: var(--ink); text-decoration: none; }
  .tab.on { color: var(--ink); font-weight: 600; border-bottom-color: var(--accent); }
  .tab .count { font-size: .72rem; font-weight: 600; padding: .05rem .4rem;
                border-radius: 99px; background: var(--mute-bg); color: var(--mute-ink); }
  .tab.on .count { background: #dbeafe; color: #1e40af; }

  .controls { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap;
              padding: .7rem .75rem; }
  .controls .spacer { flex: 1 1 auto; }
  .controls .rowcount { color: var(--ink-dim); font-size: .8rem; }
  .search { min-width: 18rem; flex: 0 1 22rem; }

  input, select { font: inherit; padding: .35rem .55rem; border: 1px solid #d3d6dc;
                  border-radius: 6px; background: var(--surface); color: inherit; }
  input:focus-visible, select:focus-visible, button:focus-visible, a:focus-visible {
    outline: 2px solid var(--accent); outline-offset: 1px; }

  button { font: inherit; font-weight: 500; padding: .35rem .7rem;
           border: 1px solid #d3d6dc; background: var(--surface);
           border-radius: 6px; cursor: pointer; color: inherit; }
  button:hover { background: var(--line-soft); border-color: #c7cad1; }
  button.link { border: 0; background: none; color: var(--accent); padding: .35rem .2rem; }
  button.link:hover { text-decoration: underline; background: none; }

  /* ---------- table ---------- */
  .tablewrap { background: var(--surface); border: 1px solid var(--line);
               border-radius: var(--radius); overflow: auto; max-height: 74vh; }
  table { border-collapse: separate; border-spacing: 0; width: 100%; }
  th, td { text-align: left; padding: .6rem .75rem; vertical-align: top;
           border-bottom: 1px solid var(--line-soft); }
  th { position: sticky; top: 0; z-index: 1; background: #fafbfc;
       font-weight: 600; font-size: .72rem; text-transform: uppercase;
       letter-spacing: .05em; color: var(--ink-dim); white-space: nowrap;
       border-bottom: 1px solid var(--line); }
  tbody tr:hover { background: #fbfcfd; }
  tbody tr:last-child td { border-bottom: 0; }
  tr.flagged td:first-child { box-shadow: inset 3px 0 0 #ef4444; }
  td.url { max-width: 20rem; }
  td.url a { display: inline-block; max-width: 100%; overflow: hidden;
             text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
  td.actions { text-align: right; white-space: nowrap; }
  td.actions form { display: inline-block; margin-left: .35rem; }

  .toolbar { display: flex; gap: .75rem; align-items: center; flex-wrap: wrap;
             margin-bottom: .75rem; }
  .found { color: var(--bad-ink); font-size: .78rem; margin-top: .15rem; }
  .date { font-variant-numeric: tabular-nums; white-space: nowrap;
          color: var(--ink-dim); }
  .date.due { color: var(--bad-ink); font-weight: 600; }
  td.err { max-width: 14rem; overflow: hidden; text-overflow: ellipsis;
           white-space: nowrap; color: var(--ink-dim); font-size: .8rem; }

  .banner { background: #fffbeb; border: 1px solid #fcd34d; color: #78350f;
            border-radius: var(--radius); padding: .8rem 1rem; margin: 0 0 1.25rem; }
  .ok-text  { color: var(--ok-ink);  font-size: .75rem; font-weight: 600; }
  .bad-text { color: var(--bad-ink); font-size: .75rem; font-weight: 600; }
  .banner code { background: #fef3c7; padding: .05rem .3rem; border-radius: 4px; }
  code { font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; }

  /* ---------- pills ---------- */
  .pill { display: inline-block; padding: .12rem .5rem; border-radius: 99px;
          font-size: .72rem; font-weight: 600; white-space: nowrap; }
  .ok    { background: var(--ok-bg);   color: var(--ok-ink); }
  .bad   { background: var(--bad-bg);  color: var(--bad-ink); }
  .warn  { background: var(--warn-bg); color: var(--warn-ink); }
  .muted { background: var(--mute-bg); color: var(--mute-ink); }

  .empty { padding: 3rem 1.5rem; text-align: center; color: var(--ink-dim);
           background: var(--surface); border: 1px solid var(--line);
           border-radius: var(--radius); }

  @media (max-width: 720px) {
    main { padding: 1rem; }
    .search { min-width: 0; flex: 1 1 100%; }
  }
  /* ---------- verdicts ---------- */
  .v-excellent { background: #dcfce7; color: #14663a; }
  .v-good      { background: #e0f2fe; color: #075985; }
  .v-meh       { background: #fef3c7; color: #92400e; }
  .v-bad       { background: #fee2e2; color: #991b1b; }
  .v-manipulation { background: #fae8ff; color: #86198f; }
  .v-prefail   { background: #f1f2f4; color: #52525b; }
  .reason { color: var(--ink-dim); font-size: .82rem; max-width: 34rem; }
  .kw { font-size: .78rem; color: var(--ink-dim); }
  .stage { font-variant-numeric: tabular-nums; }
  .newrun textarea { width: 100%; min-height: 8rem; font: 13px ui-monospace, Menlo, monospace;
                     padding: .6rem; border: 1px solid #d3d6dc; border-radius: 6px; }
  .newrun { background: var(--surface); border: 1px solid var(--line);
            border-radius: var(--radius); padding: 1rem; margin-bottom: 1.5rem; }
  .newrun .row { display: flex; gap: .5rem; margin-top: .6rem; align-items: center; }
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <style dangerouslySetInnerHTML={{ __html: css }} />
        <Nav />
        <main>{children}</main>
      </body>
    </html>
  );
}
