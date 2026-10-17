const mediaTranslationFile = "src/test/mediaCaptionTranslationHardDelete.native.test.ts";
const mediaTranslationScript = "node scripts/run-memory-native-tests.mjs media-translation " + mediaTranslationFile;
const accountMediaFile = "src/test/accountDeletionMediaBoundary.native.test.ts";
const encodingFile = "src/test/mediaAdaptiveEncoding.real.test.ts";
const apiJobHeader = [
  "  api-server-tests:",
  "    name: api-server · node:test suite",
  "    runs-on: ubuntu-24.04",
  "    timeout-minutes: 60",
  "    needs: preflight",
  "    steps:",
].join("\n");
const postgresPreparationStep = [
  "      - name: Build verified PostgreSQL for native Memory tests",
  "        id: memory-postgres",
  "        timeout-minutes: 10",
  "        shell: bash",
  "        run: |",
  "          set -euo pipefail",
  '          node .github/scripts/prepare-memory-native-postgres.mjs 2>&1 | tee "$RUNNER_TEMP/memory-native-prepare.log"',
].join("\n");
const mediaTranslationStep = [
  "      - name: Require native media translation deletion suite",
  "        timeout-minutes: 5",
  "        shell: bash",
  "        env:",
  "          PORTAVA_TEST_POSTGRES_BIN: ${{ steps.memory-postgres.outputs.bin }}",
  "          TMPDIR: /tmp",
  "        run: |",
  "          set -euo pipefail",
  '          bash .github/scripts/pnpm-run.sh artifacts/api-server @workspace/api-server test:media-translation-native 2>&1 | tee "$RUNNER_TEMP/media-translation-native.log"',
].join("\n");

const accountMediaStep = [
  "      - name: Require native account media erasure suite",
  "        timeout-minutes: 5",
  "        shell: bash",
  "        env:",
  "          PORTAVA_TEST_POSTGRES_BIN: ${{ steps.memory-postgres.outputs.bin }}",
  "          TMPDIR: /tmp",
  "        run: |",
  "          set -euo pipefail",
  '          bash .github/scripts/pnpm-run.sh artifacts/api-server @workspace/api-server test:account-media-native 2>&1 | tee "$RUNNER_TEMP/account-media-native.log"',
].join("\n");
const encodingCacheStep = [
  "      - name: Cache pinned media encoding source archives",
  "        uses: actions/cache@v4",
  "        with:",
  "          path: |",
  "            ${{ runner.temp }}/media-encoding-source/ffmpeg-8.0.tar.xz",
  "            ${{ runner.temp }}/media-encoding-source/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.gz",
  "          key: media-encoding-source-v1-b2751fccb6cc4c77708113cd78b561059b6fa904b24162fa0be2d60273d27b8e-cd71a7515b0e9a012e1ac9b1f8415bebcaf6fc97d4db32286642ac4c0fbe24f9",
].join("\n");
const encodingPreparationStep = [
  "      - name: Build verified media encoding tools",
  "        id: media-encoding",
  "        timeout-minutes: 6",
  "        shell: bash",
  "        run: |",
  "          set -euo pipefail",
  '          node .github/scripts/prepare-media-encoding-tools.mjs 2>&1 | tee "$RUNNER_TEMP/media-encoding-prepare.log"',
].join("\n");
const encodingStep = [
  "      - name: Require real media encoding suite",
  "        timeout-minutes: 7",
  "        shell: bash",
  "        env:",
  "          FFMPEG_PATH: ${{ steps.media-encoding.outputs.ffmpeg }}",
  "          FFPROBE_PATH: ${{ steps.media-encoding.outputs.ffprobe }}",
  "          TMPDIR: /tmp",
  "        run: |",
  "          set -euo pipefail",
  '          bash .github/scripts/pnpm-run.sh artifacts/api-server @workspace/api-server test:media-encoding 2>&1 | tee "$RUNNER_TEMP/media-encoding.log"',
].join("\n");

function requireStep(steps, expected) {
  const name = expected.split("\n")[0];
  if (steps.filter(step => step === expected).length !== 1
    || steps.filter(step => step.split("\n")[0] === name).length !== 1) {
    throw new Error(`Mandatory execution step changed: ${name.trim()}`);
  }
  return steps.indexOf(expected);
}

export function requiredCiTestFiles(scripts, workflow) {
  if (scripts["test:media-translation-native"] !== mediaTranslationScript) {
    throw new Error("Mandatory Media native command changed; review its execution registration");
  }
  if (scripts["test:account-media-native"] !== "node scripts/run-memory-native-tests.mjs account-media " + accountMediaFile
    || scripts["test:media-encoding"] !== "node scripts/run-media-encoding-tests.mjs " + encodingFile) {
    throw new Error("Mandatory account Media or encoding command changed; review its execution registration");
  }
  const jobs = workflow.split(/(?=^  [a-zA-Z0-9_-]+:\s*$)/m);
  const apiJobs = jobs.filter(job => job.startsWith("  api-server-tests:\n"));
  if (apiJobs.length !== 1) {
    throw new Error("Required API test job must exist exactly once");
  }
  const job = apiJobs[0];
  const steps = job.split(/(?=^      - )/m)
    .map(step => step.split("\n").filter(line => !/^\s*#/.test(line)).join("\n").trimEnd());
  if (steps[0] !== apiJobHeader) {
    throw new Error("Required API test job must retain its exact reviewed unconditional header");
  }
  if (steps.slice(1).some(step => step.split("\n").some(line => line.trim() && !/^ {6}/.test(line)))) {
    throw new Error("Required API test job cannot introduce job-level properties after its steps begin");
  }
  if (steps.filter(step => step === mediaTranslationStep).length !== 1
    || steps.filter(step => /^      - name: Require native media translation deletion suite$/m.test(step)).length !== 1) {
    throw new Error("Required Media native step must match the bounded fail-closed execution contract exactly");
  }
  const preparation = steps.indexOf(postgresPreparationStep);
  if (preparation < 0 || preparation >= steps.indexOf(mediaTranslationStep)
    || steps.filter(step => step === postgresPreparationStep).length !== 1
    || steps.filter(step => /^      - name: Build verified PostgreSQL for native Memory tests$/m.test(step)).length !== 1) {
    throw new Error("Mandatory Media native gate needs prior verified PostgreSQL preparation");
  }
  const account = requireStep(steps, accountMediaStep);
  const cache = requireStep(steps, encodingCacheStep);
  const encodingPreparation = requireStep(steps, encodingPreparationStep);
  const encoding = requireStep(steps, encodingStep);
  if (preparation >= account || cache >= encodingPreparation || encodingPreparation >= encoding) {
    throw new Error("Mandatory account Media and encoding gates require their verified preparation first");
  }
  return new Set([mediaTranslationFile, accountMediaFile, encodingFile]);
}
