// Windows' child.kill() terminates Node without running JS signal handlers.
// Closing the private parent pipe lets server/index.js drain HTTP and SQLite on
// normal quit, and also shuts down the child if the Electron parent disappears.
if (process.channel) {
  process.once('disconnect', () => {
    if (!process.emit('SIGTERM')) process.exit(0); // Parent quit during startup.
  });
  process.channel.unref();
}
