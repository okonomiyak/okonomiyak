// Generates GitHub stats / top-languages SVG cards for the profile README.
// Runs in GitHub Actions; no external services or npm deps.
// Private repos/contributions are included when the token belongs to the user
// (a personal access token); the default Actions token only sees public data.
//
// Usage: GITHUB_TOKEN=... GITHUB_USER=okonomiyak node scripts/generate-stats.mjs [outDir]
// Set STATS_MOCK=path/to/data.json to render from saved data without calling the API.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const OUT_DIR = process.argv[2] ?? "generated";
const USER = process.env.GITHUB_USER;
const TOKEN = process.env.GITHUB_TOKEN;

// tokyonight palette
const THEME = {
  bg: "#1a1b27",
  title: "#70a5fd",
  text: "#38bdae",
  icon: "#bf91f3",
  border: "#1a1b27",
};

const QUERY = `
query($login: String!, $after: String) {
  user(login: $login) {
    name
    login
    contributionsCollection { totalCommitContributions restrictedContributionsCount }
    pullRequests { totalCount }
    issues { totalCount }
    repositoriesContributedTo(contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]) { totalCount }
    repositories(first: 100, after: $after, ownerAffiliations: OWNER, isFork: false) {
      pageInfo { hasNextPage endCursor }
      nodes {
        stargazerCount
        languages(first: 100, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name color } }
        }
      }
    }
  }
}`;

async function graphql(variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "profile-stats-generator",
    },
    body: JSON.stringify({ query: QUERY, variables }),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  if (!json.data.user) throw new Error(`User not found: ${variables.login}`);
  return json.data.user;
}

async function fetchData() {
  let after = null;
  let first;
  const repos = [];
  do {
    const user = await graphql({ login: USER, after });
    first ??= user;
    repos.push(...user.repositories.nodes);
    const { hasNextPage, endCursor } = user.repositories.pageInfo;
    after = hasNextPage ? endCursor : null;
  } while (after);

  const langs = new Map();
  for (const repo of repos) {
    for (const { size, node } of repo.languages.edges) {
      const cur = langs.get(node.name) ?? { name: node.name, color: node.color ?? "#858585", size: 0, repos: 0 };
      cur.size += size;
      cur.repos += 1;
      langs.set(node.name, cur);
    }
  }

  const cc = first.contributionsCollection;
  return {
    name: first.name || first.login,
    stars: repos.reduce((sum, r) => sum + r.stargazerCount, 0),
    commits: cc.totalCommitContributions + cc.restrictedContributionsCount,
    prs: first.pullRequests.totalCount,
    issues: first.issues.totalCount,
    contributedTo: first.repositoriesContributedTo.totalCount,
    languages: [...langs.values()].sort((a, b) => b.size - a.size),
  };
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n));

// Both cards share one size so they line up side by side in the README.
const CARD_W = 400;
const CARD_H = 195;

function card(title, body) {
  const width = CARD_W;
  const height = CARD_H;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">
  <style>
    .title { font: 600 18px 'Segoe UI', Ubuntu, Sans-Serif; fill: ${THEME.title}; }
    .label { font: 600 14px 'Segoe UI', Ubuntu, Sans-Serif; fill: ${THEME.text}; }
    .value { font: 700 14px 'Segoe UI', Ubuntu, Sans-Serif; fill: ${THEME.text}; }
    .lang  { font: 400 12px 'Segoe UI', Ubuntu, Sans-Serif; fill: ${THEME.text}; }
  </style>
  <rect x="0.5" y="0.5" rx="4.5" width="${width - 1}" height="${height - 1}" fill="${THEME.bg}" stroke="${THEME.border}"/>
  <text x="25" y="35" class="title">${esc(title)}</text>
${body}
</svg>
`;
}

function statsCard(d) {
  const rows = [
    ["Total Stars Earned", d.stars],
    ["Total Commits (last year)", d.commits],
    ["Total PRs", d.prs],
    ["Total Issues", d.issues],
    ["Contributed to (last year)", d.contributedTo],
  ];
  const body = rows
    .map(([label, value], i) => {
      const y = 70 + i * 25;
      return `  <circle cx="31" cy="${y - 5}" r="5" fill="${THEME.icon}"/>
  <text x="45" y="${y}" class="label">${esc(label)}:</text>
  <text x="300" y="${y}" class="value">${fmt(value)}</text>`;
    })
    .join("\n");
  return card(`${d.name}'s GitHub Stats`, body);
}

function langsCard(d, limit = 8) {
  const top = d.languages.slice(0, limit);
  const total = top.reduce((s, l) => s + l.size, 0);
  const barWidth = CARD_W - 50;
  if (total === 0) {
    return card("Most Used Languages", `  <text x="25" y="65" class="lang">No language data yet</text>`);
  }

  let x = 25;
  const bar = top
    .map((l) => {
      const w = (l.size / total) * barWidth;
      const seg = `    <rect x="${x.toFixed(2)}" y="50" width="${w.toFixed(2)}" height="8" fill="${esc(l.color)}"/>`;
      x += w;
      return seg;
    })
    .join("\n");

  const legend = top
    .map((l, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const lx = 25 + col * 175;
      const ly = 88 + row * 26;
      const pct = ((l.size / total) * 100).toFixed(1);
      return `  <circle cx="${lx + 5}" cy="${ly - 4}" r="5" fill="${esc(l.color)}"/>
  <text x="${lx + 15}" y="${ly}" class="lang">${esc(l.name)} ${pct}%</text>`;
    })
    .join("\n");

  const body = `  <mask id="bar-mask"><rect x="25" y="50" width="${barWidth}" height="8" rx="5" fill="#fff"/></mask>
  <g mask="url(#bar-mask)">
${bar}
  </g>
${legend}`;
  return card("Most Used Languages", body);
}

const fmtBytes = (n) => {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
};

// Full list of every language, unlike the card which only shows the top few.
function languagesMarkdown(d) {
  const total = d.languages.reduce((s, l) => s + l.size, 0);
  const lines = [
    `# ${d.name} が使っている言語`,
    "",
    "自分が所有するリポジトリ（フォークを除く）のコード量から集計しています。",
    "`.github/workflows/stats.yml` で自動更新されます。",
    "",
  ];
  if (total === 0) return [...lines, "まだ言語データがありません。", ""].join("\n");
  lines.push(
    `全 ${d.languages.length} 言語`,
    "",
    "| # | 言語 | 割合 | コード量 | リポジトリ数 |",
    "|--:|---|--:|--:|--:|",
    ...d.languages.map(
      (l, i) =>
        `| ${i + 1} | ${l.name.replace(/\|/g, "\\|")} | ${((l.size / total) * 100).toFixed(2)}% | ${fmtBytes(l.size)} | ${l.repos ?? "-"} |`,
    ),
    "",
  );
  return lines.join("\n");
}

async function main() {
  let data;
  if (process.env.STATS_MOCK) {
    data = JSON.parse(await readFile(process.env.STATS_MOCK, "utf8"));
  } else {
    if (!USER || !TOKEN) throw new Error("GITHUB_USER and GITHUB_TOKEN must be set");
    data = await fetchData();
  }
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, "stats.svg"), statsCard(data));
  await writeFile(join(OUT_DIR, "top-langs.svg"), langsCard(data));
  await writeFile(join(OUT_DIR, "LANGUAGES.md"), languagesMarkdown(data));
  console.log(`Wrote stats.svg, top-langs.svg and LANGUAGES.md to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
