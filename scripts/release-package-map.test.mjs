import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReleasePackagePlan,
  checkConfiguration,
  findUnpublishableWorkspaceEdges,
  getReleasePackages,
} from "./release-package-map.mjs";

function pkg(name, { publishFromCi, ...deps } = {}) {
  return { name, dir: name, publishFromCi, pkg: { name, ...deps } };
}

test("release package manifest covers all public packages with explicit CI enrollment", () => {
  const packages = buildReleasePackagePlan();
  assert.ok(packages.length > 0);
  assert.ok(packages.every((pkg) => typeof pkg.publishFromCi === "boolean"));
});

test("release package list only contains CI-enrolled packages", () => {
  const enabledPackages = getReleasePackages();
  // During the fork's @valadrien-os/* publishing-deferred transition the
  // enabled list can legitimately be empty; once any package is bootstrapped
  // on npm and re-enrolled, this list will be non-empty again.
  assert.ok(enabledPackages.every((pkg) => pkg.publishFromCi === true));
});

test("Hermes release surface publishes the unified built-in package and keeps gateway as a shim", () => {
  const packages = buildReleasePackagePlan();
  const hermes = packages.find((pkg) => pkg.name === "@valadrien-os/hermes-paperclip-adapter");
  const gatewayShim = packages.find((pkg) => pkg.name === "@valadrien-os/adapter-hermes-gateway");

  assert.equal(hermes?.dir, "packages/adapters/hermes");
  assert.equal(hermes?.publishFromCi, true);
  assert.equal(gatewayShim?.dir, "packages/adapters/hermes-gateway");
  assert.equal(gatewayShim?.publishFromCi, false);
});

test("release package configuration validates successfully", () => {
  assert.doesNotThrow(() => checkConfiguration());
});

test("guard flags a publishFromCi:true package depending on a publishFromCi:false package", () => {
  const problems = findUnpublishableWorkspaceEdges([
    pkg("@valadrien-os/server", {
      publishFromCi: true,
      dependencies: { "@valadrien-os/skills-catalog": "workspace:*" },
    }),
    pkg("@valadrien-os/skills-catalog", { publishFromCi: false }),
  ]);

  assert.equal(problems.length, 1);
  assert.match(problems[0], /@paperclipai\/server/);
  assert.match(problems[0], /@paperclipai\/skills-catalog/);
});

test("guard inspects optional and peer dependency sections too", () => {
  const problems = findUnpublishableWorkspaceEdges([
    pkg("@valadrien-os/server", {
      publishFromCi: true,
      optionalDependencies: { "@valadrien-os/opt": "workspace:^" },
      peerDependencies: { "@valadrien-os/peer": "workspace:*" },
    }),
    pkg("@valadrien-os/opt", { publishFromCi: false }),
    pkg("@valadrien-os/peer", { publishFromCi: false }),
  ]);

  assert.equal(problems.length, 2);
});

test("guard treats a workspace dep on an unknown @paperclipai package as unpublishable", () => {
  const problems = findUnpublishableWorkspaceEdges([
    pkg("@valadrien-os/server", {
      publishFromCi: true,
      dependencies: { "@valadrien-os/private-internal": "workspace:*" },
    }),
  ]);

  assert.equal(problems.length, 1);
});

test("guard allows true->true workspace edges", () => {
  const problems = findUnpublishableWorkspaceEdges([
    pkg("@valadrien-os/server", {
      publishFromCi: true,
      dependencies: { "@valadrien-os/shared": "workspace:*" },
    }),
    pkg("@valadrien-os/shared", { publishFromCi: true }),
  ]);

  assert.deepEqual(problems, []);
});

test("guard ignores non-workspace specs, non-internal deps, and edges from off-train packages", () => {
  const problems = findUnpublishableWorkspaceEdges([
    pkg("@valadrien-os/server", {
      publishFromCi: true,
      dependencies: {
        "@valadrien-os/pinned": "0.3.1",
        zod: "^3.0.0",
      },
    }),
    pkg("@valadrien-os/pinned", { publishFromCi: false }),
    pkg("@valadrien-os/offtrain", {
      publishFromCi: false,
      dependencies: { "@valadrien-os/also-off": "workspace:*" },
    }),
    pkg("@valadrien-os/also-off", { publishFromCi: false }),
  ]);

  assert.deepEqual(problems, []);
});

test("the live release manifest has no unpublishable workspace edges", () => {
  assert.deepEqual(findUnpublishableWorkspaceEdges(buildReleasePackagePlan()), []);
});
