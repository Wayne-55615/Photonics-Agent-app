import SnpHtmlViewer from "@/components/SnpHtmlViewer";

export default async function SpectrumPage({
  params,
  searchParams,
}: {
  params: Promise<{ filename: string }>;
  searchParams: Promise<{ embedded?: string; seed?: string; center?: string; seed_center?: string }>;
}) {
  const { filename } = await params;
  const { embedded, seed, center, seed_center } = await searchParams;

  // Both centers are in nm. `seed_center` = baseline (gray line);
  // `center` = current (black line). Anything non-finite or way outside
  // a sensible photonics range is treated as missing.
  const parseNm = (v: unknown): number | null => {
    if (typeof v !== "string" || !v) return null;
    const x = parseFloat(v);
    return (Number.isFinite(x) && x > 0 && x < 100000) ? x : null;
  };

  return (
    <SnpHtmlViewer
      filename={decodeURIComponent(filename)}
      seedFilename={seed ? decodeURIComponent(seed) : null}
      targetCenterNm={parseNm(seed_center)}
      currentCenterNm={parseNm(center)}
      embedded={embedded === "1"}
    />
  );
}
