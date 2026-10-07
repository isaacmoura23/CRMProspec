// `after()` roda a tarefa na hora: o MCP não tem ciclo de resposta HTTP.
module.exports = {
  after(cb) {
    Promise.resolve().then(cb).catch((err) => console.error("[mcp] after():", err));
  },
  NextResponse: class {},
};
