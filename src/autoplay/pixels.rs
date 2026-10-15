//! Reading a few pixels of the game, for what the page does not say.
//!
//! Mahjong Soul draws everything into one canvas and keeps its interface's
//! state inside its engine, out of reach of the page's script. Some of that
//! state shows only as colour: whether one of the client's own toggles (auto
//! sort, auto win, no calls, auto tsumogiri) is on is whether its glyph is
//! green. A screenshot of the glyph's few pixels reads it.

use anyhow::{anyhow, Context, Result};
use chromiumoxide::cdp::browser_protocol::page::{
    CaptureScreenshotFormat, CaptureScreenshotParams, Viewport,
};
use chromiumoxide::page::Page;
use std::io::Read;

/// What a toggle's glyph shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Glyph {
    /// Green: the toggle is on.
    Lit,
    /// The light grey-blue of a toggle that is off.
    Unlit,
    /// Neither: the strip is folded away, or something covers it.
    Absent,
}

/// What the glyph in the CSS-pixel box `(x, y, w, h)` of the page shows.
pub async fn glyph(page: &Page, x: f64, y: f64, w: f64, h: f64) -> Result<Glyph> {
    let params = CaptureScreenshotParams::builder()
        .format(CaptureScreenshotFormat::Png)
        .clip(Viewport {
            x,
            y,
            width: w.max(1.0),
            height: h.max(1.0),
            scale: 1.0,
        })
        .build();
    let shot = page
        .execute(params)
        .await
        .context("CDP captureScreenshot")?;
    use base64::Engine;
    let png = base64::engine::general_purpose::STANDARD
        .decode(AsRef::<str>::as_ref(&shot.result.data))
        .context("screenshot: base64")?;
    let pixels = decode_png(&png).ok_or_else(|| anyhow!("screenshot: not a PNG this reads"))?;
    Ok(classify(&pixels))
}

/// A glyph is lit when enough of its box is the toggles' green, unlit when
/// enough is their grey-blue, and absent otherwise.
pub fn classify(pixels: &[[u8; 3]]) -> Glyph {
    if pixels.is_empty() {
        return Glyph::Absent;
    }
    let green = |&[r, g, b]: &[u8; 3]| g > 140 && i32::from(g) - i32::from(r.max(b)) > 70;
    let grey = |&[r, g, b]: &[u8; 3]| {
        let (lo, hi) = (r.min(g).min(b), r.max(g).max(b));
        lo > 110 && hi - lo < 60 && i32::from(g) - i32::from(r.max(b)) < 20
    };
    let share = |f: &dyn Fn(&[u8; 3]) -> bool| {
        pixels.iter().filter(|p| f(p)).count() as f64 / pixels.len() as f64
    };
    if share(&green) >= 0.08 {
        Glyph::Lit
    } else if share(&grey) >= 0.08 {
        Glyph::Unlit
    } else {
        Glyph::Absent
    }
}

/// The RGB pixels of an 8-bit, non-interlaced RGB or RGBA PNG, as Chromium
/// writes its screenshots; `None` for anything else.
pub fn decode_png(png: &[u8]) -> Option<Vec<[u8; 3]>> {
    const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    if png.len() < 8 || png[..8] != SIGNATURE {
        return None;
    }
    let (mut width, mut height, mut channels) = (0usize, 0usize, 0usize);
    let mut data = Vec::new();
    let mut at = 8;
    while at + 8 <= png.len() {
        let len = u32::from_be_bytes(png[at..at + 4].try_into().ok()?) as usize;
        let kind = &png[at + 4..at + 8];
        let body = png.get(at + 8..at + 8 + len)?;
        match kind {
            b"IHDR" => {
                width = u32::from_be_bytes(body.get(0..4)?.try_into().ok()?) as usize;
                height = u32::from_be_bytes(body.get(4..8)?.try_into().ok()?) as usize;
                let (depth, colour, interlace) = (*body.get(8)?, *body.get(9)?, *body.get(12)?);
                channels = match (depth, colour, interlace) {
                    (8, 2, 0) => 3,
                    (8, 6, 0) => 4,
                    _ => return None,
                };
            }
            b"IDAT" => data.extend_from_slice(body),
            b"IEND" => break,
            _ => {}
        }
        at += 12 + len;
    }
    if width == 0 || height == 0 || channels == 0 {
        return None;
    }
    let mut raw = Vec::new();
    flate2::read::ZlibDecoder::new(data.as_slice())
        .read_to_end(&mut raw)
        .ok()?;
    let stride = width * channels;
    if raw.len() < height * (stride + 1) {
        return None;
    }
    let mut out = Vec::with_capacity(width * height);
    let mut previous = vec![0u8; stride];
    for row in 0..height {
        let line = &raw[row * (stride + 1)..(row + 1) * (stride + 1)];
        let (filter, line) = (line[0], &line[1..]);
        let mut current = vec![0u8; stride];
        for i in 0..stride {
            let left = if i >= channels {
                current[i - channels]
            } else {
                0
            };
            let up = previous[i];
            let corner = if i >= channels {
                previous[i - channels]
            } else {
                0
            };
            let predicted = match filter {
                0 => 0,
                1 => left,
                2 => up,
                3 => ((u16::from(left) + u16::from(up)) / 2) as u8,
                4 => paeth(left, up, corner),
                _ => return None,
            };
            current[i] = line[i].wrapping_add(predicted);
        }
        out.extend(current.chunks_exact(channels).map(|p| [p[0], p[1], p[2]]));
        previous = current;
    }
    Some(out)
}

fn paeth(a: u8, b: u8, c: u8) -> u8 {
    let (a, b, c) = (i16::from(a), i16::from(b), i16::from(c));
    let p = a + b - c;
    let (pa, pb, pc) = ((p - a).abs(), (p - b).abs(), (p - c).abs());
    if pa <= pb && pa <= pc {
        a as u8
    } else if pb <= pc {
        b as u8
    } else {
        c as u8
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// A PNG of `pixels` (RGB, one row each of `width`), filtered with `filter`.
    fn png(width: usize, rows: &[Vec<[u8; 3]>], filter: u8) -> Vec<u8> {
        let mut raw = Vec::new();
        let mut previous = vec![0u8; width * 3];
        for row in rows {
            let line: Vec<u8> = row.iter().flatten().copied().collect();
            raw.push(filter);
            for i in 0..line.len() {
                let left = if i >= 3 { line[i - 3] } else { 0 };
                let predicted = match filter {
                    0 => 0,
                    1 => left,
                    2 => previous[i],
                    _ => unreachable!(),
                };
                raw.push(line[i].wrapping_sub(predicted));
            }
            previous = line;
        }
        let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        z.write_all(&raw).unwrap();
        let idat = z.finish().unwrap();
        let chunk = |kind: &[u8], body: &[u8]| {
            let mut c = (body.len() as u32).to_be_bytes().to_vec();
            c.extend_from_slice(kind);
            c.extend_from_slice(body);
            c.extend_from_slice(&[0, 0, 0, 0]); // the CRC is not checked
            c
        };
        let mut ihdr = (width as u32).to_be_bytes().to_vec();
        ihdr.extend_from_slice(&(rows.len() as u32).to_be_bytes());
        ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
        let mut out = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        out.extend(chunk(b"IHDR", &ihdr));
        out.extend(chunk(b"IDAT", &idat));
        out.extend(chunk(b"IEND", &[]));
        out
    }

    /// Pixels come back as they went in, whichever filter the rows use.
    #[test]
    fn a_png_reads_back_its_pixels() {
        let rows = vec![
            vec![[10, 200, 30], [40, 50, 60]],
            vec![[255, 0, 128], [7, 8, 9]],
        ];
        for filter in [0, 1, 2] {
            let read = decode_png(&png(2, &rows, filter)).expect("decoded");
            assert_eq!(read, rows.concat(), "filter {filter}");
        }
        assert!(decode_png(b"not a png").is_none());
    }

    /// The toggles' green reads lit, their grey-blue unlit, the dark strip
    /// with nothing on it absent. The colours are the ones measured on the
    /// client: a lit glyph about (60, 230, 60), an unlit one about (150, 158, 170).
    #[test]
    fn a_glyph_reads_lit_unlit_or_absent() {
        let back = [20u8, 24, 52];
        let with = |glyph: [u8; 3]| -> Vec<[u8; 3]> {
            (0..100)
                .map(|i| if i % 4 == 0 { glyph } else { back })
                .collect()
        };
        assert_eq!(classify(&with([60, 230, 60])), Glyph::Lit);
        assert_eq!(classify(&with([150, 158, 170])), Glyph::Unlit);
        assert_eq!(classify(&vec![back; 100]), Glyph::Absent);
        assert_eq!(classify(&[]), Glyph::Absent);
    }
}
