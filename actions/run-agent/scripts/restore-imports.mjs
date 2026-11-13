// Claude Code expands "@path" imports in CLAUDE.md, AGENTS.md and rule files into the session's
// instructions, and it loads an import inside the working directory without asking. The files
// that restore-config.sh restores are trusted, but what they import would still be the pull
// request's version. This replaces every imported file with the one from the base branch, and
// removes one the base branch does not have.
// Usage: restore-imports.mjs <checkout of the base branch>, in the checkout of the PR.
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Imports can import, four hops deep. https://code.claude.com/docs/en/memory#import-additional-files
const MAX_HOPS = 4;
const INSTRUCTION_FILES = new Set(["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"]);

// Paths a file imports, as written. Code spans and fenced blocks are not imports. A path ends
// at the first space without a backslash; one that ends a sentence is tried without the
// punctuation too, since restoring a file that is not imported after all does no harm.
export function importsOf(text) {
  const prose = text.replace(/^(```|~~~)[\s\S]*?^\1.*$/gm, "").replace(/`[^`\n]*`/g, "");
  const found = new Set();
  for (const [, raw] of prose.matchAll(/(?:^|\s)@((?:\\ |\S)+)/g)) {
    const path = raw.replaceAll("\\ ", " ");
    found.add(path);
    const bare = path.replace(/[.,;:!?)\]]+$/, "");
    if (bare) found.add(bare);
  }
  return [...found];
}

// lstat throws when a parent of the path is a file, which a path taken from text can be.
function isFile(path) {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

// The instruction files as they are after restore-config.sh: the base branch's.
function instructionFiles(root, skip) {
  const found = [];
  const walk = (dir, inRules) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (skip.has(path) || entry.name === "node_modules") continue;
      if (entry.isDirectory()) walk(path, inRules || path.endsWith(join(".claude", "rules")));
      else if (entry.isFile() && (INSTRUCTION_FILES.has(entry.name) || (inRules && entry.name.endsWith(".md")))) found.push(path);
    }
  };
  walk(root, false);
  return found;
}

// A symlink on the way would take the copy, and Claude Code's read, somewhere else, so it always
// goes. A file where the base branch has a directory goes only to make room for a copy: without
// one, the import leads nowhere and the file is the pull request's own.
function clearTheWay(root, target, makeRoom) {
  const parts = relative(root, target).split(sep);
  let path = root;
  for (const [i, part] of parts.entries()) {
    path = join(path, part);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    // Nothing here, or a file that stays: there is no way further down.
    if (!stat) return;
    const blocks = makeRoom && i < parts.length - 1 && !stat.isDirectory();
    if (stat.isSymbolicLink() || blocks) return rmSync(path, { force: true });
    if (!stat.isDirectory()) return;
  }
}

// The checkout of this action, which the reusable workflows put in the working directory, is
// not the pull request's either.
const OWN = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

export function restoreImports(root, trusted, log = console.log, own = OWN) {
  root = resolve(root);
  trusted = resolve(root, trusted);
  const skip = new Set([join(root, ".git"), trusted, ...(own === root ? [] : [own])]);
  const inside = (path) => !relative(root, path).startsWith("..") && ![...skip].some((dir) => !relative(dir, path).startsWith(".."));
  const seen = new Set();
  let queue = instructionFiles(root, skip);
  for (let hop = 1; hop <= MAX_HOPS && queue.length; hop++) {
    const next = [];
    for (const file of queue) {
      for (const written of importsOf(readFileSync(file, "utf8"))) {
        // "~/" and absolute paths outside the checkout are external imports, which a session
        // without a person to approve them does not load.
        if (written.startsWith("~")) continue;
        const target = normalize(isAbsolute(written) ? written : join(dirname(file), written));
        if (!inside(target) || target === root || seen.has(target)) continue;
        seen.add(target);
        const source = join(trusted, relative(root, target));
        clearTheWay(root, target, isFile(source));
        if (isFile(source)) {
          mkdirSync(dirname(target), { recursive: true });
          rmSync(target, { recursive: true, force: true });
          copyFileSync(source, target);
          log(`import ${relative(root, target)}: from the base branch`);
          next.push(target);
        } else if (isFile(target)) {
          rmSync(target, { force: true });
          log(`import ${relative(root, target)}: not on the base branch, removed`);
        }
      }
    }
    queue = next;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) restoreImports(process.cwd(), process.argv[2]);
