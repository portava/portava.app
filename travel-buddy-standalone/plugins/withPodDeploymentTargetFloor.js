/**
 * withPodDeploymentTargetFloor — Expo config plugin: at prebuild, give the
 * generated ios/Podfile a post_install step that raises every pod target below
 * the app's iOS deployment target to it. Why and what: plugins/podDeploymentTargetFloor.js.
 *
 * A "dangerous" mod because the Podfile is plain Ruby text with no typed mod;
 * the edit is idempotent and tagged `@generated begin/end`, the convention the
 * maplibre plugin uses in the same block, so repeated prebuilds keep one copy.
 */
'use strict';

const { withDangerousMod } = require('expo/config-plugins');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { applyPodDeploymentTargetFloor } = require('./podDeploymentTargetFloor');

const withPodDeploymentTargetFloor = (config) =>
  withDangerousMod(config, [
    'ios',
    (c) => {
      const podfile = join(c.modRequest.platformProjectRoot, 'Podfile');
      const before = readFileSync(podfile, 'utf8');
      const after = applyPodDeploymentTargetFloor(before);
      if (after !== before) writeFileSync(podfile, after);
      return c;
    },
  ]);

module.exports = withPodDeploymentTargetFloor;
