// Learn more: https://docs.expo.dev/guides/customizing-metro/
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Exclude the `.agents/` skills directory from Metro's file watcher and resolver.
// `npx skills add` installs full tool repos there (lockfiles, symlinks, nested
// package trees ~78MB), which crash Metro's watcher (ENOENT on transient paths)
// and are never part of the app bundle. Matches both `/` and `\` separators.
const excludeAgents = /[\\/]\.agents[\\/]/;
const existing = config.resolver.blockList;
config.resolver.blockList = existing
  ? (Array.isArray(existing) ? [...existing, excludeAgents] : [existing, excludeAgents])
  : excludeAgents;

module.exports = config;
