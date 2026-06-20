#!/usr/bin/env node
/**
 * amux CLI -- Agent Multiplexer command-line interface
 *
 * Usage: amux <command> [options]
 *
 * Commands:
 *   project create|list|delete|rename
 *   agent   create|list|delete|rename
 *   role    add|list|delete
 *   task    add|list|assign|pick|done|drop|block
 *   send    <project> --from <agent> --to <agent> <message>
 *   workspace sync|status
 *
 * For interactive use within Pi, install the amux-pi extension.
 */

const args = process.argv.slice(2);
const cmd = args[0] ?? "help";

if (cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log(`amux -- Agent Multiplexer

Usage: amux <command> [options]

Commands:
  project   Manage projects (create, list, delete, rename)
  agent     Manage agents (create, list, delete, rename)
  role      Manage roles (add, list, delete)
  task      Manage tasks (add, list, assign, pick, done, drop, block)
  send      Send a message between agents
  workspace Git workspace operations (sync, status)
  help      Show this help

For interactive use within Pi:
  pi install git:github.com/amutix/amux

Documentation: https://github.com/amutix/amux`);
} else {
  console.log(`amux: command "${cmd}" not yet implemented.`);
  console.log("CLI is under development. Use the Pi extension for full functionality.");
}
