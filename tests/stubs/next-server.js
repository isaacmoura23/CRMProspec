// Stub de next/server: `after` executa a callback imediatamente (e engole erros),
// NextResponse não é usado nos testes.
module.exports = {
  after(cb) {
    Promise.resolve().then(cb).catch(() => {});
  },
  NextResponse: class {},
};
