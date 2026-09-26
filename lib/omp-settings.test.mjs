import assert from "node:assert/strict";
import test from "node:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { orderedSettings } from "@oh-my-pi/pi-coding-agent/config/all-settings";
import {
  SETTING_TABS,
  getEnumValues,
  getPathsForTab,
  getSetting,
  getType,
  getUi,
  isCredential,
  isSettingConfigured,
  setSetting,
} from "./omp-settings.ts";

/** In-memory settings instance; writes never reach config.yml (Settings.isolated is `inMemory`). */
function isolated(overrides = {}) {
  return Settings.isolated(overrides);
}

test("getSetting reads a value supplied as an override", () => {
  const settings = isolated({ "goal.enabled": false });
  assert.equal(getSetting(settings, "goal.enabled"), false);
  assert.equal(isSettingConfigured(settings, "goal.enabled"), true);
});

test("getSetting falls back to the registered default, which is not 'configured'", () => {
  const settings = isolated();
  assert.equal(getSetting(settings, "goal.enabled"), true);
  assert.equal(isSettingConfigured(settings, "goal.enabled"), false);
});

test("getSetting reads a value under a nested path", () => {
  const settings = isolated({ "composer.shape": "box" });
  assert.equal(getSetting(settings, "composer.shape"), "box");
  assert.equal(isSettingConfigured(settings, "composer.shape"), true);
});

test("getSetting returns undefined for an unknown path", () => {
  const settings = isolated();
  assert.equal(getSetting(settings, "definitely.not.a.setting"), undefined);
  assert.equal(getSetting(settings, ""), undefined);
  assert.equal(isSettingConfigured(settings, "definitely.not.a.setting"), false);
});

test("setSetting writes to the global layer of the instance it is given", () => {
  const settings = isolated();
  assert.equal(isSettingConfigured(settings, "goal.enabled"), false);

  setSetting(settings, "goal.enabled", false);
  assert.equal(getSetting(settings, "goal.enabled"), false);
  assert.equal(isSettingConfigured(settings, "goal.enabled"), true);

  setSetting(settings, "goal.enabled", true);
  assert.equal(getSetting(settings, "goal.enabled"), true);
});

test("setSetting accepts a string value for a string setting", () => {
  const settings = isolated();
  setSetting(settings, "plan.autosaveDir", "/tmp/plans");
  assert.equal(getSetting(settings, "plan.autosaveDir"), "/tmp/plans");
  assert.equal(isSettingConfigured(settings, "plan.autosaveDir"), true);
});

test("setSetting does not leak into another instance", () => {
  const written = isolated();
  const untouched = isolated();
  setSetting(written, "goal.enabled", false);
  assert.equal(getSetting(untouched, "goal.enabled"), true);
  assert.equal(isSettingConfigured(untouched, "goal.enabled"), false);
});

test("setSetting rejects a value the definition does not accept", () => {
  const settings = isolated();
  assert.throws(() => setSetting(settings, "goal.enabled", "not-a-boolean"), /expected a boolean/);
  assert.throws(() => setSetting(settings, "symbolPreset", "comic-sans"), /expected one of/);
  // The rejected writes left the defaults in place.
  assert.equal(getSetting(settings, "goal.enabled"), true);
  assert.equal(getSetting(settings, "symbolPreset"), "unicode");
});

test("setSetting throws for an unknown path", () => {
  const settings = isolated();
  assert.throws(() => setSetting(settings, "definitely.not.a.setting", true), /Unknown setting/);
  assert.throws(() => setSetting(settings, "definitely.not.a.setting", true), {
    message: "Unknown setting: definitely.not.a.setting",
  });
});

test("getPathsForTab lists only settings whose ui.tab is that tab", () => {
  for (const tab of SETTING_TABS) {
    const paths = getPathsForTab(tab);
    assert.ok(paths.length > 0, `expected ${tab} to expose at least one setting`);
    for (const path of paths) {
      assert.equal(getUi(path)?.tab, tab, `${path} does not belong to the ${tab} tab`);
    }
  }
});

test("getPathsForTab covers every setting that has ui metadata, in panel order", () => {
  const panelOrder = orderedSettings().map(setting => setting.id);
  const listed = [];
  for (const tab of SETTING_TABS) {
    const paths = getPathsForTab(tab);
    // Panel order is registration order, so each tab's slice must be a subsequence of it.
    const positions = paths.map(path => panelOrder.indexOf(path));
    assert.ok(
      positions.every(position => position >= 0),
      "every listed path must be a registered setting",
    );
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b), `tab ${tab} is out of panel order`);
    listed.push(...paths);
  }
  assert.equal(new Set(listed).size, listed.length, "a setting must not be listed on two tabs");
  const withUi = orderedSettings().filter(setting => setting.ui !== undefined).map(setting => setting.id);
  assert.deepEqual([...listed].sort(), [...withUi].sort());
});

test("getPathsForTab includes theme.dark on the appearance tab only", () => {
  assert.ok(getPathsForTab("appearance").includes("theme.dark"));
  for (const tab of SETTING_TABS.filter(tab => tab !== "appearance")) {
    assert.ok(!getPathsForTab(tab).includes("theme.dark"), `theme.dark must not be listed on ${tab}`);
  }
});

test("isCredential, getType and getEnumValues read a setting's registered metadata", () => {
  assert.equal(isCredential("searxng.token"), true);
  assert.equal(getType("searxng.token"), "string");

  assert.equal(isCredential("goal.enabled"), false);
  assert.equal(getType("goal.enabled"), "boolean");

  assert.equal(getType("symbolPreset"), "enum");
  assert.deepEqual(getEnumValues("symbolPreset"), ["unicode", "nerd", "ascii"]);

  // Enum values are a property of the enum type only.
  assert.equal(getEnumValues("goal.enabled"), undefined);
  assert.equal(getEnumValues("theme.dark"), undefined);
});

test("metadata lookups on an unknown path stay undefined/false", () => {
  assert.equal(isCredential("definitely.not.a.setting"), false);
  assert.equal(getType("definitely.not.a.setting"), undefined);
  assert.equal(getEnumValues("definitely.not.a.setting"), undefined);
});
