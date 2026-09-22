import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { MAX_PDF_BYTES } from "@/services/career/pdf";
import { ownerOf, storeUploadedResume } from "@/services/career/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Upload do PDF no modo local (sem Supabase Storage).
 *
 * Route handler em vez de server action porque actions têm corpo limitado a
 * 1 MB por padrão. Em hospedagem serverless há ainda o limite da
 * plataforma (na Vercel, 4,5 MB por requisição): acima disso o caminho
 * correto é o upload direto ao Storage, que `prepareResumeUpload` devolve
 * quando o Supabase está configurado.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_PDF_BYTES + 4096) return NextResponse.json({ error: "Arquivo acima do limite de 10 MB." }, { status: 413 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Envio inválido." }, { status: 400 });
  }
  const versionId = String(form.get("versionId") ?? "");
  const file = form.get("file");
  if (!versionId || !(file instanceof Blob)) return NextResponse.json({ error: "Arquivo ou versão ausentes." }, { status: 400 });
  if (file.size > MAX_PDF_BYTES) return NextResponse.json({ error: "Arquivo acima do limite de 10 MB." }, { status: 413 });

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await storeUploadedResume(ownerOf(user), versionId, bytes);
    return NextResponse.json({ ok: true, versionId: result.version.id, duplicateOf: result.duplicateOf, textStatus: result.version.text_status });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Falha no upload." }, { status: 400 });
  }
}
