import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const root = new URL("../../../../", import.meta.url);
const load = async () => {
  const moduleUrl = new URL("../../scripts/required-ci-test-registration.mjs", import.meta.url);
  const runtime = await import(moduleUrl.href) as {
    requiredCiTestFiles: (scripts: Record<string, string>, workflow: string) => Set<string>;
  };
  const { scripts } = JSON.parse(await readFile(new URL("artifacts/api-server/package.json", root), "utf8"));
  const workflow = await readFile(new URL(".github/workflows/ci.yml", root), "utf8");
  return { ...runtime, scripts: scripts as Record<string, string>, workflow };
};

describe("required CI test registration cannot substitute optional or missing execution", () => {
  it("recognizes the exact required Media native command, not arbitrary focused scripts", async () => {
    const { requiredCiTestFiles, scripts, workflow } = await load();
    assert.deepEqual([...requiredCiTestFiles(scripts, workflow)], [
      "src/test/mediaCaptionTranslationHardDelete.native.test.ts",
      "src/test/accountDeletionMediaBoundary.native.test.ts",
      "src/test/memoryImportBatches.pglite.test.ts",
      "src/test/memoryFromOwnMedia.pglite.test.ts",
      "src/test/mediaAdaptiveEncoding.real.test.ts",
      "src/test/inputOutcomeConsent.postgres.test.ts",
      "src/test/wallOutcomeConsent.postgres.test.ts",
      "src/test/mediaEventPrivacy.postgres.test.ts",
    ]);
  });

  for (const script of ["test:memory-import-sql", "test:account-media-native", "test:media-encoding", "test:input-outcome-native", "test:wall-outcome-native", "test:media-events-native"]) {
    for (const [label, change] of [
      ["missing", () => ""],
      ["filtered", (command: string) => command + " --test-only"],
      ["wrong file", (command: string) => command.replace(/src\/test\/\S+/, "src/test/unrelated.test.ts")],
      ["masked failure", (command: string) => command + " || true"],
    ] as const) it(`refuses ${label} ${script}`, async () => {
      const { requiredCiTestFiles, scripts, workflow } = await load();
      assert.throws(() => requiredCiTestFiles({ ...scripts, [script]: change(scripts[script]!) }, workflow), /Mandatory (?:account Media or encoding|signal privacy) command/);
    });
  }

  for (const name of [
    "Require native account media erasure suite", "Require reusable memory import SQL suite", "Cache pinned media encoding source archives",
    "Build verified media encoding tools", "Require real media encoding suite",
  ]) {
    for (const [label, replace] of [
      ["condition", (step: string) => step.replace("\n", "\n        if: false\n")],
      ["optional", (step: string) => step.replace("\n", "\n        continue-on-error: true\n")],
      ["quoted condition", (step: string) => step.replace("\n", '\n        "if": false\n')],
      ["missing", () => ""],
      ["duplicate", (step: string) => step + "\n\n" + step],
      ["commented", (step: string) => step.replace("      - name:", "      # - name:")],
    ] as const) it(`refuses ${label} ${name}`, async () => {
      const { requiredCiTestFiles, scripts, workflow } = await load();
      const step = workflow.split(/(?=^      - )/m).find(part => part.startsWith(`      - name: ${name}\n`))!.split("\n\n")[0]!;
      assert.ok(step);
      assert.throws(() => requiredCiTestFiles(scripts, workflow.replace(step, replace(step))));
    });
  }

  for (const [before, after] of [
    ["test:account-media-native 2>&1", "test:unrelated 2>&1"],
    ["test:media-encoding 2>&1", "test:unrelated 2>&1"],
    ["FFMPEG_PATH: ${{ steps.media-encoding.outputs.ffmpeg }}", "FFMPEG_PATH: /unverified/ffmpeg"],
    ["FFPROBE_PATH: ${{ steps.media-encoding.outputs.ffprobe }}", "FFPROBE_PATH: /unverified/ffprobe"],
    ['tee "$RUNNER_TEMP/account-media-native.log"', 'tee "$RUNNER_TEMP/account-media-native.log" || true'],
    ['tee "$RUNNER_TEMP/media-encoding.log"', 'tee "$RUNNER_TEMP/media-encoding.log" || true'],
    ["media-encoding-source-v1-b2751fcc", "media-encoding-source-v1-unknown"],
    ["      - name: Cache pinned media encoding source archives\n", "      - name: Cache pinned media encoding source archives\n        restore-keys: media-encoding-source-\n"],
  ] as const) it(`refuses changed account Media or encoding evidence: ${before}`, async () => {
    const { requiredCiTestFiles, scripts, workflow } = await load();
    assert.ok(workflow.includes(before));
    assert.throws(() => requiredCiTestFiles(scripts, workflow.replace(before, after)));
  });

  for (const [name, predecessor] of [
    ["Require native account media erasure suite", "Build verified PostgreSQL for native Memory tests"],
    ["Build verified media encoding tools", "Cache pinned media encoding source archives"],
    ["Require real media encoding suite", "Build verified media encoding tools"],
  ]) it(`refuses ${name} before its preparation`, async () => {
    const { requiredCiTestFiles, scripts, workflow } = await load();
    const step = workflow.split(/(?=^      - )/m).find(part => part.startsWith(`      - name: ${name}\n`))!.split("\n\n")[0]!;
    const moved = workflow.replace(step, "").replace(`      - name: ${predecessor}\n`, `${step}\n\n      - name: ${predecessor}\n`);
    assert.throws(() => requiredCiTestFiles(scripts, moved));
  });

  it("keeps required real encoding and account erasure out of optional ordinary execution", async () => {
    const { scripts } = await load();
    for (const script of [scripts.pretest!, scripts.test!]) {
      assert.ok(!script.includes("mediaAdaptiveEncoding.real.test.ts"));
      assert.ok(!script.includes("accountDeletionMediaBoundary.native.test.ts"));
    }
  });

  for (const [label, change] of [
    ["missing command", () => ""],
    ["filtered command", (command: string) => command + " --test-only"],
    ["wrong profile", (command: string) => command.replace("media-translation ", "review ")],
    ["different file", (command: string) => command.replace("mediaCaptionTranslationHardDelete.native", "unrelated")],
  ] as const) it(`refuses ${label}`, async () => {
    const { requiredCiTestFiles, scripts, workflow } = await load();
    assert.throws(() => requiredCiTestFiles({ ...scripts, "test:media-translation-native": change(scripts["test:media-translation-native"]!) }, workflow), /Mandatory Media native command/);
  });

  for (const [label, before, after] of [
    ["job condition", "  api-server-tests:\n", "  api-server-tests:\n    if: false\n"],
    ["optional job", "  api-server-tests:\n", "  api-server-tests:\n    continue-on-error: true\n"],
    ["missing job", "  api-server-tests:\n", "  other-job:\n"],
    ["step condition", "      - name: Require native media translation deletion suite\n", "      - name: Require native media translation deletion suite\n        if: false\n"],
    ["optional step", "      - name: Require native media translation deletion suite\n", "      - name: Require native media translation deletion suite\n        continue-on-error: true\n"],
    ["commented step", "      - name: Require native media translation deletion suite\n", "      # - name: Require native media translation deletion suite\n"],
    ["wrong command", "test:media-translation-native 2>&1", "test:unrelated 2>&1"],
    ["ignored failure", 'tee "$RUNNER_TEMP/media-translation-native.log"', 'tee "$RUNNER_TEMP/media-translation-native.log" || true'],
    ["wrong runtime", "          PORTAVA_TEST_POSTGRES_BIN: ${{ steps.memory-postgres.outputs.bin }}\n          TMPDIR: /tmp\n        run: |\n          set -euo pipefail\n          bash .github/scripts/pnpm-run.sh artifacts/api-server @workspace/api-server test:media-translation-native", "          PORTAVA_TEST_POSTGRES_BIN: /unverified\n          TMPDIR: /tmp\n        run: |\n          set -euo pipefail\n          bash .github/scripts/pnpm-run.sh artifacts/api-server @workspace/api-server test:media-translation-native"],
    ["optional preparation", "      - name: Build verified PostgreSQL for native Memory tests\n", "      - name: Build verified PostgreSQL for native Memory tests\n        if: false\n"],
    ["missing preparation", "      - name: Build verified PostgreSQL for native Memory tests\n", "      - name: Unverified preparation\n"],
  ] as const) it(`refuses ${label}`, async () => {
    const { requiredCiTestFiles, scripts, workflow } = await load();
    assert.ok(workflow.includes(before));
    assert.throws(() => requiredCiTestFiles(scripts, workflow.replace(before, after)));
  });

  it("refuses a duplicated required step", async () => {
    const { requiredCiTestFiles, scripts, workflow } = await load();
    const step = workflow.split(/(?=^      - )/m).find(part => part.startsWith("      - name: Require native media translation deletion suite\n"))!;
    const end = step.indexOf("\n\n");
    const duplicate = end < 0 ? step : step.slice(0, end);
    assert.throws(() => requiredCiTestFiles(scripts, workflow.replace(duplicate, duplicate + "\n" + duplicate)));
  });

  for (const key of ['"if"', "'if'", "if ", '"continue-on-error"', "'continue-on-error'", "continue-on-error "]) {
    it(`refuses noncanonical optional job key ${key}`, async () => {
      const { requiredCiTestFiles, scripts, workflow } = await load();
      const value = key.includes("if") ? "false" : "true";
      assert.throws(() => requiredCiTestFiles(scripts, workflow.replace("  api-server-tests:\n", `  api-server-tests:\n    ${key}: ${value}\n`)));
    });
    it(`refuses noncanonical optional preparation key ${key}`, async () => {
      const { requiredCiTestFiles, scripts, workflow } = await load();
      const value = key.includes("if") ? "false" : "true";
      const start = "      - name: Build verified PostgreSQL for native Memory tests\n";
      assert.throws(() => requiredCiTestFiles(scripts, workflow.replace(start, `${start}        ${key}: ${value}\n`)));
    });
  }

  for (const header of ["    <<: *optional-job\n", "    ? if\n    : false\n", "    steps: []\n", "    runs-on: unverified-runner\n"]) {
    it(`refuses unreviewed job-header structure ${header.trim()}`, async () => {
      const { requiredCiTestFiles, scripts, workflow } = await load();
      assert.throws(() => requiredCiTestFiles(scripts, workflow.replace("  api-server-tests:\n", `  api-server-tests:\n${header}`)));
    });
  }

  for (const line of ["          exit 0\n", "          true ||\n"]) {
    it(`refuses extra preparation instructions ${line.trim()}`, async () => {
      const { requiredCiTestFiles, scripts, workflow } = await load();
      const command = "          node .github/scripts/prepare-memory-native-postgres.mjs 2>&1";
      assert.throws(() => requiredCiTestFiles(scripts, workflow.replace(command, line + command)));
    });
  }

  for (const property of ['if: false', '"if": false', 'if : false', 'continue-on-error: true', '"continue-on-error": true', 'continue-on-error : true']) {
    it(`refuses late job property ${property} after an unrelated step`, async () => {
      const { requiredCiTestFiles, scripts, workflow } = await load();
      const boundary = "  api-server-local-db:\n";
      assert.ok(workflow.includes(boundary));
      const late = `      - name: Synthetic harmless later step\n        run: echo test\n    ${property}\n\n`;
      assert.throws(() => requiredCiTestFiles(scripts, workflow.replace(boundary, late + boundary)));
    });
  }

  it("accepts unrelated ordinary later steps without job properties", async () => {
    const { requiredCiTestFiles, scripts, workflow } = await load();
    const boundary = "  api-server-local-db:\n";
    const late = "      - name: Synthetic harmless later step\n        run: echo test\n\n";
    assert.deepEqual([...requiredCiTestFiles(scripts, workflow.replace(boundary, late + boundary))], [
      "src/test/mediaCaptionTranslationHardDelete.native.test.ts",
      "src/test/accountDeletionMediaBoundary.native.test.ts",
      "src/test/memoryImportBatches.pglite.test.ts",
      "src/test/memoryFromOwnMedia.pglite.test.ts",
      "src/test/mediaAdaptiveEncoding.real.test.ts",
      "src/test/inputOutcomeConsent.postgres.test.ts",
      "src/test/wallOutcomeConsent.postgres.test.ts",
      "src/test/mediaEventPrivacy.postgres.test.ts",
    ]);
  });
});

import { readdir } from "node:fs/promises";
describe("the existing required SQL job registers its actual file discovery without another test run", () => {
  const fixture = async () => {
    const { scripts, workflow } = await load();
    const module = await import(new URL("../../scripts/required-ci-test-registration.mjs", import.meta.url).href) as {
      requiredLocalDatabaseTestFiles: (scripts: Record<string,string>, workflow: string, runner: string, files: string[]) => Set<string>;
    };
    const runner = await readFile(new URL("artifacts/api-server/scripts/local-db/run-tests.sh", root), "utf8");
    const files = (await readdir(new URL("artifacts/api-server/src/test/db/", root))).filter(name => name.endsWith(".db.test.ts")).map(name => `src/test/db/${name}`);
    return { ...module, scripts, workflow, runner, files };
  };
  it("registers exactly the existing SQL runner population, including the new capture and retirement tests", async () => {
    const f = await fixture();
    const actual = f.requiredLocalDatabaseTestFiles(f.scripts, f.workflow, f.runner, f.files);
    assert.deepEqual([...actual].sort(), f.files.sort());
    for (const name of ["mediaAssetRetry", "memoryCaptureUpload", "mediaAssetRetirement"]) assert.ok(actual.has(`src/test/db/${name}.db.test.ts`));
  });
  for (const [label, change] of [
    ["missing job", (s:string) => s.replace("  api-server-local-db:\n", "  unrelated-job:\n")],
    ["optional job", (s:string) => s.replace("  api-server-local-db:\n", "  api-server-local-db:\n    if: false\n")],
    ["masked failure", (s:string) => s.replace("@workspace/api-server test:db-local\n", "@workspace/api-server test:db-local || true\n")],
    ["different database", (s:string) => s.replace("localhost:5432/portava_local", "localhost:5432/unreviewed")],
  ] as const) it(`refuses ${label}`, async () => {
    const f=await fixture();const changed=change(f.workflow);assert.notEqual(changed,f.workflow);
    assert.throws(()=>f.requiredLocalDatabaseTestFiles(f.scripts,changed,f.runner,f.files),/Required SQL job/);
  });
  for (const [label, change] of [
    ["filtered file population", (s:string)=>s.replace("ls src/test/db/*.db.test.ts", "ls src/test/db/postcard*.db.test.ts")],
    ["parallel fixture writes", (s:string)=>s.replaceAll("--test-concurrency=1", "--test-concurrency=2")],
    ["skips accepted", (s:string)=>s.replace('[ "${skip:-1}" = "0" ]', '[ "${skip:-1}" -ge "0" ]')],
    ["early success", (s:string)=>s.replace("set -euo pipefail", "exit 0\nset -euo pipefail")],
  ] as const) it(`refuses ${label}`, async () => {
    const f=await fixture();const changed=change(f.runner);assert.notEqual(changed,f.runner);
    assert.throws(()=>f.requiredLocalDatabaseTestFiles(f.scripts,f.workflow,changed,f.files),/Required SQL runner/);
  });
  it("refuses a focused script or an unrelated file inventory", async()=>{
    const f=await fixture();assert.throws(()=>f.requiredLocalDatabaseTestFiles({...f.scripts,"test:db-local":"true"},f.workflow,f.runner,f.files),/Required SQL command/);
    assert.throws(()=>f.requiredLocalDatabaseTestFiles(f.scripts,f.workflow,f.runner,["src/test/unrelated.test.ts"]),/inventory/);
  });
});
