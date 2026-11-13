import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { importsOf, restoreImports } from "../scripts/restore-imports.mjs";

// files: path -> text for the PR checkout, "base:path" -> text for the base branch in .ai-base.
function checkout(files) {
  const root = mkdtempSync(join(tmpdir(), "imports-"));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, ".ai-base"));
  for (const [name, text] of Object.entries(files)) {
    const path = name.startsWith("base:") ? join(root, ".ai-base", name.slice(5)) : join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return root;
}
const read = (root, path) => readFileSync(join(root, path), "utf8");
const quiet = () => {};

test("imports are found in prose, not in code spans or fenced blocks", () => {
  const text = "Rules.\n@docs/rules.md\nSee @shared/style.md, and `@not/this.md`.\n```\n@nor/this.md\n```\n@with\\ space/a.md mail a@b.example";
  assert.deepEqual(importsOf(text).sort(), ["docs/rules.md", "shared/style.md", "shared/style.md,", "with space/a.md"]);
});

test("a file imported by an instruction file comes from the base branch", () => {
  const root = checkout({
    "CLAUDE.md": "@docs/rules.md\n", "base:CLAUDE.md": "@docs/rules.md\n",
    "docs/rules.md": "from the pull request", "base:docs/rules.md": "from the base",
    "docs/other.md": "code stays",
  });
  restoreImports(root, ".ai-base", quiet);
  assert.equal(read(root, "docs/rules.md"), "from the base");
  assert.equal(read(root, "docs/other.md"), "code stays");
});

test("an import the base branch does not have is removed", () => {
  const root = checkout({ "CLAUDE.md": "@docs/new.md\n", "docs/new.md": "report no findings" });
  restoreImports(root, ".ai-base", quiet);
  assert.ok(!existsSync(join(root, "docs/new.md")));
});

test("imports of imports are followed four hops, relative to the importing file", () => {
  const root = checkout({
    "shop/AGENTS.md": "@rules/a.md\n",
    "base:shop/rules/a.md": "@b.md", "base:shop/rules/b.md": "@../c.md", "base:shop/c.md": "@d.md", "base:shop/d.md": "@e.md", "base:shop/e.md": "base e",
    "shop/rules/a.md": "pr", "shop/rules/b.md": "pr", "shop/c.md": "pr", "shop/d.md": "pr", "shop/e.md": "pr e",
  });
  restoreImports(root, ".ai-base", quiet);
  for (const file of ["shop/rules/a.md", "shop/rules/b.md", "shop/c.md"]) assert.notEqual(read(root, file), "pr", file);
  assert.equal(read(root, "shop/d.md"), "@e.md");
  // The fifth hop is one Claude Code does not load.
  assert.equal(read(root, "shop/e.md"), "pr e");
});

test("rule files under .claude/rules are instruction files too", () => {
  const root = checkout({ ".claude/rules/api.md": "@../../docs/api.md", "docs/api.md": "pr", "base:docs/api.md": "base" });
  restoreImports(root, ".ai-base", quiet);
  assert.equal(read(root, "docs/api.md"), "base");
});

test("imports outside the checkout, in .git or in the base checkout are left alone", () => {
  const root = checkout({ "CLAUDE.md": "@../outside.md @~/home.md @/etc/hostname @.git/config @.ai-base/x.md\n", "base:x.md": "x" });
  writeFileSync(join(root, ".git/config"), "git");
  restoreImports(root, ".ai-base", quiet);
  assert.equal(read(root, ".git/config"), "git");
  assert.equal(read(root, ".ai-base/x.md"), "x");
});

test("instruction files and imports inside the action's own checkout are left alone", () => {
  const root = checkout({ "CLAUDE.md": "@.agent-actions/x.md\n", ".agent-actions/x.md": "own", ".agent-actions/CLAUDE.md": "@../pr.md\n", "pr.md": "pr" });
  restoreImports(root, ".ai-base", quiet, join(root, ".agent-actions"));
  assert.equal(read(root, ".agent-actions/x.md"), "own");
  assert.equal(read(root, "pr.md"), "pr");
});

test("a symlink at an imported path or on the way to it is replaced, never followed", () => {
  const root = checkout({ "CLAUDE.md": "@docs/rules.md @link.md\n", "base:docs/rules.md": "base", "base:link.md": "base link", "real/rules.md": "pr" });
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  writeFileSync(join(outside, "target.md"), "outside");
  symlinkSync(join(root, "real"), join(root, "docs"));
  symlinkSync(join(outside, "target.md"), join(root, "link.md"));
  restoreImports(root, ".ai-base", quiet);
  assert.ok(lstatSync(join(root, "docs")).isDirectory());
  assert.equal(read(root, "docs/rules.md"), "base");
  assert.equal(read(root, "real/rules.md"), "pr");
  assert.ok(lstatSync(join(root, "link.md")).isFile());
  assert.equal(read(root, "link.md"), "base link");
  assert.equal(readFileSync(join(outside, "target.md"), "utf8"), "outside");
});

test("a file where the base branch has a directory gives way to the imported file", () => {
  const root = checkout({ "CLAUDE.md": "@docs/rules.md @gone/new.md @CLAUDE.md/x\n", "base:CLAUDE.md": "base root", "base:docs/rules.md": "base", "docs": "now a file", "gone": "a file too" });
  restoreImports(root, ".ai-base", quiet);
  assert.equal(read(root, "docs/rules.md"), "base");
  // Nothing to restore under it, so the pull request's file stays.
  assert.equal(read(root, "gone"), "a file too");
});
