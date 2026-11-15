# Changelog

## 0.3.0

An activity dashboard, an activity history, and a foundation for dependency and AI-assisted features. Everything from 0.2.0 stays: the Explorer view, its settings, commands and colours are unchanged.

**New**

- **Activity dashboard** in its own Activity Bar container (Changescope, view "Activity"), with six tabs: Overview, Activity, Code, Git, Sessions and Settings. It can also be opened in an editor tab (`Changescope: Open Dashboard in Editor`). Built for a narrow sidebar and the keyboard, uses VS Code theme colours, and honours reduced motion.
- **Three visual modes** (`changescope.viewMode`): `live` (the original shaking rows), `compact` (calm single-line rows, also stops the shaking in the Explorer view) and `impact` (rows show an impact estimate). `changescope.animationIntensity` scales how far rows shake in both views.
- **Activity history** with six source classes (Developer, AI agent, External, Git, Automated, Unknown), each with the detection method and a confidence value. Rapid changes to one file by one source are merged into one event. Changes by something other than you start as "unreviewed" and can be marked reviewed. History is kept per workspace across restarts (`changescope.history.*`) and holds paths, counts and labels, never file contents.
- **Pause and resume** (`Changescope: Pause Tracking` and `Resume Tracking`, or the dashboard toggle). Paused windows record nothing; rows already shown stay.
- **Git awareness** through the built-in Git extension: branch, commit, ahead and behind, staged, changed and untracked files, and "open diff". A repository state change (checkout, pull, commit) labels file changes in the same few seconds as `git`. This is a time correlation, not proof. Shows why when Git is disabled or missing.
- **Dependency index and impact estimate** (`changescope.dependencies.*`): who imports a file and what it imports, built in the background the first time you inspect a file, then updated one file at a time. Impact levels (low to critical) come from import edges and are estimates, not defects. Related test files are listed.
- **Sessions**: start and stop a session yourself, rename it, and export a Markdown report (workspace-relative paths and counts only; opened as an unsaved document, nothing is written to disk).
- **Collision warning**: a notice when a file changes on disk while you have unsaved edits in it, with "Compare with Saved". Changescope never changes or reloads your document (`changescope.collisions.notify`).
- **AI foundation, local only**: a metadata-only summary built on your machine. A provider interface, consent dialog and secret storage plumbing exist so another extension can register a summary provider (`registerAiProvider` on the API). Changescope ships no network provider and sends nothing anywhere. Files matching `changescope.sensitiveGlobs` are never read for dependency analysis and never part of any request.
- **Experimental agent signal file** (`changescope.experimental.agentSignals`, off by default): a hook that you configure yourself appends to a file, and Changescope labels those files `AI agent`. Also `reportAgentActivity` on the extension API. This is not an integration with any specific tool; without a report, agent writes show as External.
- Extension API additions (`apiVersion` stays 1): `registerAiProvider`, `reportAgentActivity`, `getActivityEvents`, `getSessions`, `getDashboardState`.
- 16 commands and 13 settings; see the README.

**Changed**

- **File Shake is now Changescope.** The name now says what the extension does: show what changed in your workspace, who or what changed it, and what it affects. The display name, extension id, command ids, setting keys, view ids and colour ids all changed from the `fileShake.` prefix to `changescope.`. Behaviour is unchanged, but anything you configured under `fileShake.` (settings, keybindings, colour customisations) has to be set again under `changescope.`. The GitHub repository keeps its current name for now.
- `package.json` repository URL is now `https://github.com/AblorhSowah/file-shake.git`, and `npm run package` no longer needs `--allow-missing-repository`. The publisher is still a placeholder until a Marketplace publisher id is chosen.
- GitHub Actions workflows for CI (build, lint, unit tests on Linux, macOS and Windows; integration tests on Linux) and for building a release `.vsix`.

**Fixed before release (found by testing)**

- Session reports and AI requests no longer contain the absolute path of a file outside the workspace (or of any file when no folder is open); such files appear as `(outside workspace)/<file name>`.
- `changescope.sensitiveGlobs` matches ignoring case on every platform, and the Live view no longer reads a source file that matches it.
- A file that is deleted and created again (an atomic replace by a tool) keeps its importers in the dependency index. Impact mode no longer rescans every file for each estimate. The agent signal file is read again from its start when it is emptied and refilled, and handles a multi-byte character split across two appends.

**Limits, stated plainly**

- VS Code gives extensions no writer identity. A change is labelled `AI agent` only when an adapter reported it; everything else an agent writes shows as External. There is no Claude, Copilot or Cursor integration.
- Dependency edges come from the same text scanners as the reference counts (not a parser or language server).

## 0.2.0

Rows now stay, and there are two users.

- **Rows persist.** A file stays on screen after it stops shaking (dimmed, with its yellow references) until whoever changed it moves on. Your file stays until you switch to a different file or leave the VS Code window; a file changed by something else stays until that something changes a different file. Files changed at the same time are shown together. New setting `fileShake.persistUntilNextFile` (default on); turn it off for the old behaviour of removing idle files a few seconds after they stop.
- **Two users in the view.** The File Shake tree now has a **You** section (typing in the editor) and an **External** section (Claude Code, git, formatters, build tools), each with its own files and its own yellow references. Yellow files follow the user whose file references them.
- Clicking a row in the File Shake view no longer counts as switching files.
- Reference results are cached per document object, not just per version number, so a document closed unsaved and re-opened never shows the previous buffer's references.
- Fixed: renaming an unrelated file dropped the references of idle files; turning `showWhenIdle` off left idle rows on screen; renaming a file you were typing in relabelled it as external; a checkout rewriting open files was not treated as a flood.

## 0.1.0

Initial release.

- Live "File Shake" Explorer view: edited files green, referenced files yellow, shaking in proportion to edit rate and reference count; folders auto-expanded down to each file; click a row to open it.
- Native Explorer decorations (colour, badge, tooltip) through contributed theme colours `fileShake.editedForeground` and `fileShake.referencedForeground`.
- Source detection: `you` (typing in the focused editor) versus `external` (any other change), with self-save and burst protection.
- Reference detection for TypeScript/JavaScript, Python, Go, Java/Kotlin, C/C++, Rust, Ruby, PHP, CSS/SCSS/Less, HTML and Markdown.
- Status bar item, commands (toggle, clear, focus view, show debug info) and `fileShake.*` settings.
- Honors `prefers-reduced-motion`; strict CSP webview; light, dark and high-contrast themes.
