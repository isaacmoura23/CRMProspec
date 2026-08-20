"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, FileUp, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { importCsvRows, type CsvRow } from "@/actions/leads";

const TARGET_FIELDS: Array<{ key: keyof CsvRow; label: string; required?: boolean }> = [
  { key: "company_name", label: "Empresa", required: true },
  { key: "segment", label: "Nicho" },
  { key: "contact_name", label: "Contato" },
  { key: "phone", label: "Telefone" },
  { key: "whatsapp", label: "WhatsApp" },
  { key: "email", label: "E-mail" },
  { key: "website", label: "Site" },
  { key: "instagram", label: "Instagram" },
  { key: "city", label: "Cidade" },
  { key: "state", label: "Estado" },
  { key: "country", label: "País" },
];

const IGNORE = "__ignore__";

function parseCsv(text: string): string[][] {
  const delimiter = text.split("\n")[0]?.includes(";") ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    if (row.some((c) => c.trim() !== "")) rows.push(row);
  }
  return rows;
}

/** tenta mapear colunas automaticamente pelos nomes do cabeçalho */
function autoMap(headers: string[]): Record<number, keyof CsvRow | typeof IGNORE> {
  const map: Record<number, keyof CsvRow | typeof IGNORE> = {};
  const patterns: Array<[RegExp, keyof CsvRow]> = [
    [/empresa|company|nome.*fantasia|razao/i, "company_name"],
    [/nicho|segmento|segment|categoria/i, "segment"],
    [/contato|contact|responsavel/i, "contact_name"],
    [/whats/i, "whatsapp"],
    [/telefone|phone|fone|tel\b/i, "phone"],
    [/e-?mail/i, "email"],
    [/site|website|url/i, "website"],
    [/insta/i, "instagram"],
    [/cidade|city/i, "city"],
    [/estado|uf|state|distrito/i, "state"],
    [/pa[ií]s|country/i, "country"],
  ];
  headers.forEach((h, i) => {
    const hit = patterns.find(([re]) => re.test(h));
    map[i] = hit ? hit[1] : IGNORE;
  });
  return map;
}

export function ImportCsvDialog() {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = React.useState(false);
  const [step, setStep] = React.useState<"upload" | "map" | "done">("upload");
  const [headers, setHeaders] = React.useState<string[]>([]);
  const [rows, setRows] = React.useState<string[][]>([]);
  const [mapping, setMapping] = React.useState<Record<number, keyof CsvRow | typeof IGNORE>>({});
  const [importing, setImporting] = React.useState(false);
  const [result, setResult] = React.useState<{ imported: number; duplicates: number; errors: number } | null>(null);

  function reset() {
    setStep("upload");
    setHeaders([]);
    setRows([]);
    setMapping({});
    setResult(null);
  }

  async function onFile(file: File) {
    const text = await file.text();
    const parsed = parseCsv(text);
    if (parsed.length < 2) {
      toast("O arquivo precisa ter cabeçalho e pelo menos uma linha.", "error");
      return;
    }
    setHeaders(parsed[0]!);
    setRows(parsed.slice(1));
    setMapping(autoMap(parsed[0]!));
    setStep("map");
  }

  async function doImport() {
    const companyCol = Object.entries(mapping).find(([, v]) => v === "company_name")?.[0];
    if (companyCol === undefined) {
      toast("Mapeie qual coluna contém o nome da empresa.", "error");
      return;
    }
    setImporting(true);
    try {
      const payload: CsvRow[] = rows.map((r) => {
        const obj: Record<string, string> = {};
        for (const [idx, field] of Object.entries(mapping)) {
          if (field !== IGNORE && r[Number(idx)]) obj[field] = r[Number(idx)]!;
        }
        return obj as unknown as CsvRow;
      });
      const res = await importCsvRows(payload);
      setResult(res);
      setStep("done");
      router.refresh();
    } finally {
      setImporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <DialogTrigger asChild>
        <Button variant="secondary">
          <Upload /> Importar CSV
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Importar leads via CSV</DialogTitle>
          <DialogDescription>
            Upload → mapeamento de colunas → pré-visualização → detecção de duplicados → importação.
          </DialogDescription>
        </DialogHeader>

        {step === "upload" && (
          <label className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border-strong bg-surface-hover/40 px-6 py-12 transition-colors hover:border-primary/60">
            <FileUp className="size-8 text-muted-foreground" />
            <span className="text-sm font-medium">Clique para escolher um arquivo .csv</span>
            <span className="text-xs text-muted-foreground">Separado por vírgula ou ponto e vírgula, com cabeçalho.</span>
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
            />
          </label>
        )}

        {step === "map" && (
          <div className="space-y-4">
            <div className="grid gap-2.5 sm:grid-cols-2">
              {headers.map((h, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Label className="w-28 shrink-0 truncate text-xs" title={h}>
                    {h || `Coluna ${i + 1}`}
                  </Label>
                  <Select
                    value={mapping[i] ?? IGNORE}
                    onValueChange={(v) => setMapping((m) => ({ ...m, [i]: v as keyof CsvRow }))}
                  >
                    <SelectTrigger className="h-8 text-[13px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={IGNORE}>Ignorar</SelectItem>
                      {TARGET_FIELDS.map((f) => (
                        <SelectItem key={f.key} value={f.key}>
                          {f.label}
                          {f.required ? " *" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>

            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                Pré-visualização ({rows.length} linhas)
              </p>
              <div className="max-h-40 overflow-auto rounded-lg border border-border">
                <table className="w-full text-xs">
                  <tbody>
                    {rows.slice(0, 5).map((r, i) => (
                      <tr key={i} className="border-b border-border last:border-0">
                        {r.slice(0, headers.length).map((c, j) => (
                          <td key={j} className="max-w-32 truncate px-2 py-1.5 text-muted-foreground">
                            {c}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <DialogFooter className="mt-0">
              <Button variant="ghost" onClick={reset}>
                Voltar
              </Button>
              <Button onClick={doImport} disabled={importing}>
                {importing && <Loader2 className="animate-spin" />} Importar {rows.length} linhas
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === "done" && result && (
          <div className="space-y-4">
            <div className="flex flex-col items-center gap-2 py-4 text-center">
              <CheckCircle2 className="size-10 text-primary" />
              <p className="text-sm font-semibold">Importação concluída</p>
              <p className="text-[13px] text-muted-foreground">
                <span className="font-medium text-primary">{result.imported} importados</span>
                {" · "}
                {result.duplicates} duplicados ignorados
                {" · "}
                {result.errors} com erro
              </p>
            </div>
            <DialogFooter className="mt-0">
              <Button onClick={() => setOpen(false)}>Ver leads</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
