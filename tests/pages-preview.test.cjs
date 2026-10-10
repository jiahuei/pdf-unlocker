"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  MARKER,
  selectedPath,
  copySnapshot,
  collectSources,
  buildSite,
  commentPreviews,
} = require("../scripts/pages-preview.cjs");

const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const rootConfig = {
  root: "",
  paths: ["index.html", "style.css", "calc", "img"],
};

/** Ensures the whitelist and source prefix select runtime files without escaping the artifact. */
test("runtime paths and unsafe names", () => {
  assert.equal(selectedPath("calc/main.js", rootConfig), "calc/main.js");
  for (const file of [
    "scripts/build.js",
    "node_modules/a.js",
    "__ref__/index.html",
    ".git/config",
    "index.html.bak",
  ])
    assert.equal(selectedPath(file, rootConfig), null);
  assert.equal(
    selectedPath("src/assets/favicon.svg", { root: "src", paths: [] }),
    "assets/favicon.svg",
  );
  assert.equal(selectedPath("tests/a.js", { root: "src", paths: [] }), null);
  for (const file of [
    "/index.html",
    "../index.html",
    "calc/../../a",
    "calc\\a",
    "calc//a",
    "calc/./a",
  ])
    assert.throws(() => selectedPath(file, rootConfig), /Unsafe/);
});

/** Ensures current API refs, pagination and same-repository filtering determine deployed sources. */
test("current main and open same-repository pulls", async () => {
  const api = async (endpoint) => {
    if (endpoint.endsWith("heads/main")) return { object: { sha } };
    return [
      { number: 1, head: { sha: otherSha, repo: { full_name: "owner/site" } } },
      { number: 2, head: { sha, repo: { full_name: "fork/site" } } },
      { number: 3, head: { sha, repo: null } },
    ];
  };
  assert.deepEqual(await collectSources(api, "owner/site"), {
    main: sha,
    previews: [{ number: 1, sha: otherSha }],
  });
});

/** Ensures an open PR beyond the first API page receives a preview instead of being silently omitted. */
test("open pulls are paginated", async () => {
  const endpoints = [];
  const api = async (endpoint) => {
    endpoints.push(endpoint);
    if (endpoint.endsWith("heads/main")) return { object: { sha } };
    if (endpoint.endsWith("page=1"))
      return Array.from({ length: 100 }, (_, i) => ({
        number: i + 1,
        head: { sha, repo: { full_name: "fork/site" } },
      }));
    return [
      {
        number: 101,
        head: { sha: otherSha, repo: { full_name: "owner/site" } },
      },
    ];
  };
  assert.deepEqual((await collectSources(api, "owner/site")).previews, [
    { number: 101, sha: otherSha },
  ]);
  assert.ok(endpoints.some((endpoint) => endpoint.endsWith("page=2")));
});

function fixture(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "pages-preview-test-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = path.join(directory, "repo");
  fs.mkdirSync(repository);
  const git = (...args) =>
    execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Preview tests");
  git("config", "user.email", "preview@example.invalid");
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(repository, file)), {
      recursive: true,
    });
    fs.writeFileSync(path.join(repository, file), content);
  };
  const commit = () => {
    git("add", ".");
    git("commit", "-qm", "Synthetic snapshot");
    return git("rev-parse", "HEAD");
  };
  return { repository, output: path.join(directory, "site"), write, commit };
}

/** Ensures production remains the exact main snapshot, project-relative assets work and closed previews disappear. */
test("main root and PR snapshots remain separate", (t) => {
  const f = fixture(t);
  f.write("index.html", "main");
  f.write("calc/tax.html", '<base href="../"><link href="style.css">');
  f.write("style.css", "main style");
  f.write("__ref__/private.txt", "excluded");
  const main = f.commit();
  f.write("index.html", "PR");
  const head = f.commit();
  buildSite(f.repository, f.output, rootConfig, {
    main,
    previews: [{ number: 7, sha: head }],
  });
  assert.equal(
    fs.readFileSync(path.join(f.output, "index.html"), "utf8"),
    "main",
  );
  assert.equal(
    fs.readFileSync(path.join(f.output, "pr-preview/7/index.html"), "utf8"),
    "PR",
  );
  assert.equal(fs.existsSync(path.join(f.output, "__ref__")), false);
  const page = new URL(
    "https://example.github.io/project/pr-preview/7/calc/tax.html",
  );
  assert.equal(
    new URL("style.css", new URL("../", page)).href,
    "https://example.github.io/project/pr-preview/7/style.css",
  );
  assert.equal(
    fs.readFileSync(path.join(f.output, "pr-preview/7/style.css"), "utf8"),
    "main style",
  );
  buildSite(f.repository, f.output, rootConfig, { main, previews: [] });
  assert.equal(fs.existsSync(path.join(f.output, "pr-preview/7")), false);
  assert.equal(
    fs.readFileSync(path.join(f.output, "index.html"), "utf8"),
    "main",
  );
});

/** Ensures src-root applications retain relative asset paths without publishing repository tooling. */
test("src-prefix snapshot", (t) => {
  const f = fixture(t);
  f.write("src/index.html", '<script src="app.js"></script>');
  f.write("src/app.js", "app");
  f.write("src/assets/icon.svg", "icon");
  f.write("tests/secret.txt", "excluded");
  copySnapshot(f.repository, f.commit(), f.output, { root: "src", paths: [] });
  assert.equal(fs.readFileSync(path.join(f.output, "app.js"), "utf8"), "app");
  assert.equal(fs.existsSync(path.join(f.output, "assets/icon.svg")), true);
  assert.equal(fs.existsSync(path.join(f.output, "src")), false);
  assert.equal(fs.existsSync(path.join(f.output, "tests")), false);
});

/** Ensures Git symlinks and invalid commit identifiers never become artifact files or executable arguments. */
test("only regular Git blobs are extracted", (t) => {
  const f = fixture(t);
  fs.symlinkSync("/etc/passwd", path.join(f.repository, "index.html"));
  assert.throws(
    () => copySnapshot(f.repository, f.commit(), f.output, rootConfig),
    /Not a regular file/,
  );
  assert.throws(
    () => copySnapshot(f.repository, "--help", f.output, rootConfig),
    /Invalid source commit/,
  );
  assert.equal(fs.existsSync(path.join(f.output, "index.html")), false);
});

/** Ensures successful deployments create one marker comment, preserve user comments and update its URL/SHA. */
test("preview comments are stable and updated", async () => {
  const comments = [{ id: 3, user: { login: "human" }, body: MARKER }];
  const writes = [];
  const api = async (endpoint, method = "GET", body) => {
    if (method === "GET") return comments;
    writes.push({ endpoint, method, body });
    if (method === "POST")
      comments.push({
        id: 4,
        user: { login: "github-actions[bot]" },
        body: body.body,
        issue_url: "/repos/owner/site/issues/7",
      });
    else comments[1].body = body.body;
    return {};
  };
  const previews = [{ number: 7, sha }];
  await commentPreviews(
    api,
    "owner/site",
    "https://example.github.io/project",
    previews,
  );
  await commentPreviews(
    api,
    "owner/site",
    "https://example.github.io/project/",
    previews,
  );
  assert.equal(writes.length, 1);
  assert.match(
    writes[0].body.body,
    /https:\/\/example.github.io\/project\/pr-preview\/7\//,
  );
  assert.ok(writes[0].body.body.includes(sha));
  await commentPreviews(
    api,
    "owner/site",
    "https://example.github.io/project/",
    [{ number: 7, sha: otherSha }],
  );
  assert.equal(writes[1].method, "PATCH");
  assert.equal(writes[1].endpoint, "/repos/owner/site/issues/comments/4");
  assert.ok(writes[1].body.body.includes(otherSha));
});

/** Ensures cleanup updates only an existing same-repository closed PR comment and never creates a closed/fork comment. */
test("closed and fork comments", async () => {
  let existing = true;
  let repo = "owner/site";
  const writes = [];
  const api = async (endpoint, method = "GET", body) => {
    if (method !== "GET") {
      writes.push({ method, body });
      return {};
    }
    if (endpoint.endsWith("/pulls/7"))
      return { state: "closed", head: { repo: { full_name: repo } } };
    return existing
      ? [
          {
            id: 9,
            user: { login: "github-actions[bot]" },
            body: `${MARKER}\nold preview`,
            issue_url: "/repos/owner/site/issues/7",
          },
        ]
      : [];
  };
  await commentPreviews(api, "owner/site", "https://example.github.io/", []);
  assert.equal(writes.length, 1);
  assert.match(writes[0].body.body, /Preview removed/);
  existing = false;
  await commentPreviews(api, "owner/site", "https://example.github.io/", []);
  repo = "fork/site";
  existing = true;
  await commentPreviews(api, "owner/site", "https://example.github.io/", []);
  assert.equal(writes.length, 1);
});
