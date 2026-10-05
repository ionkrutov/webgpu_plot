/** Builds a minimal single-page PDF that embeds the supplied JPEG bytes. */
export function buildSimplePdf(jpegBytes: Uint8Array, imgW: number, imgH: number): Blob {
    const enc = new TextEncoder();
    const e = (s: string) => enc.encode(s);

    const contBytes = e(`q ${imgW} 0 0 ${imgH} 0 0 cm /Im0 Do Q\n`);

    const parts: Uint8Array[] = [];
    const xref: number[] = [0]; // xref[0] is the free object
    let pos = 0;
    const add = (...chunks: Uint8Array[]): void => {
        for (const c of chunks) { parts.push(c); pos += c.byteLength; }
    };

    add(e('%PDF-1.4\n'));

    xref.push(pos);
    add(e('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'));

    xref.push(pos);
    add(e('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'));

    xref.push(pos);
    add(e(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${imgW} ${imgH}]` +
          ` /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`));

    xref.push(pos);
    add(
        e(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH}` +
          ` /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.byteLength} >>\nstream\n`),
        jpegBytes,
        e('\nendstream\nendobj\n'),
    );

    xref.push(pos);
    add(
        e(`5 0 obj\n<< /Length ${contBytes.byteLength} >>\nstream\n`),
        contBytes,
        e('endstream\nendobj\n'),
    );

    const xrefPos = pos;
    const xrefSect = xref.map((o, i) =>
        i === 0 ? '0000000000 65535 f \n' : `${String(o).padStart(10, '0')} 00000 n \n`
    ).join('');
    add(e(`xref\n0 ${xref.length}\n${xrefSect}` +
          `trailer\n<< /Size ${xref.length} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`));

    return new Blob(parts as BlobPart[], { type: 'application/pdf' });
}
