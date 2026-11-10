//! Caffold's meerkat in the server's icon color.
//!
//! Every icon file is the gray meerkat on a transparent ground. A color keeps
//! black black and white white and turns a middle gray into the color itself,
//! so the meerkat's body takes the color and its face a pale tint of it.

use std::{borrow::Cow, io::Cursor};

use png::{BitDepth, ColorType, Decoder, Encoder};

use crate::{server_settings::ServerIcon, static_assets};

/// The icon files a server offers in each of its icons.
const FILES: [&str; 7] = [
    "favicon-32.png",
    "apple-touch-icon.png",
    "icon-192.png",
    "icon-512.png",
    "maskable-192.png",
    "maskable-512.png",
    "caffold.png",
];

/// One icon file in one icon, or `None` for a file the server does not offer.
pub(super) fn image(icon: ServerIcon, file: &str) -> Option<Result<Cow<'static, [u8]>, String>> {
    if !FILES.contains(&file) {
        return None;
    }
    let original = static_assets::get(&format!("icons/{file}"))?.body;
    Some(match color(icon) {
        None => Ok(Cow::Borrowed(original)),
        Some(color) => tint(original, color).map(Cow::Owned),
    })
}

/// The colors share one lightness, OKLCH 0.62, at hues 360/11 degrees apart
/// from 25, so a body in any of them contrasts at least 3:1 with white, the
/// dark theme's surface, and Chrome's dark tab.
fn color(icon: ServerIcon) -> Option<[u8; 3]> {
    match icon {
        ServerIcon::Default => None,
        ServerIcon::Red => Some([0xD5, 0x57, 0x53]),
        ServerIcon::Orange => Some([0xC7, 0x6B, 0x00]),
        ServerIcon::Gold => Some([0xA3, 0x82, 0x00]),
        ServerIcon::Lime => Some([0x75, 0x94, 0x00]),
        ServerIcon::Green => Some([0x00, 0xA0, 0x5E]),
        ServerIcon::Teal => Some([0x00, 0x9A, 0x93]),
        ServerIcon::Sky => Some([0x00, 0x95, 0xB7]),
        ServerIcon::Blue => Some([0x36, 0x87, 0xE3]),
        ServerIcon::Violet => Some([0x82, 0x73, 0xE0]),
        ServerIcon::Purple => Some([0xAF, 0x62, 0xC2]),
        ServerIcon::Pink => Some([0xCB, 0x57, 0x90]),
    }
}

fn tint(original: &[u8], color: [u8; 3]) -> Result<Vec<u8>, String> {
    let mut reader = Decoder::new(Cursor::new(original))
        .read_info()
        .map_err(|error| format!("icon could not be read: {error}"))?;
    let size = reader
        .output_buffer_size()
        .ok_or("icon is too large to read")?;
    let mut pixels = vec![0; size];
    let frame = reader
        .next_frame(&mut pixels)
        .map_err(|error| format!("icon could not be read: {error}"))?;
    if frame.color_type != ColorType::Rgba || frame.bit_depth != BitDepth::Eight {
        return Err("icon is not 8-bit RGBA".to_string());
    }
    pixels.truncate(frame.buffer_size());
    for pixel in pixels.chunks_exact_mut(4) {
        let lightness =
            f32::from(u16::from(pixel[0]) + u16::from(pixel[1]) + u16::from(pixel[2])) / 765.0;
        for (channel, color) in pixel[..3].iter_mut().zip(color) {
            let color = f32::from(color);
            let value = if lightness <= 0.5 {
                color * lightness * 2.0
            } else {
                color + (255.0 - color) * (lightness - 0.5) * 2.0
            };
            *channel = value.round() as u8;
        }
    }

    let mut encoded = Vec::new();
    let mut encoder = Encoder::new(&mut encoded, frame.width, frame.height);
    encoder.set_color(ColorType::Rgba);
    encoder.set_depth(BitDepth::Eight);
    let mut writer = encoder
        .write_header()
        .map_err(|error| format!("icon could not be written: {error}"))?;
    writer
        .write_image_data(&pixels)
        .map_err(|error| format!("icon could not be written: {error}"))?;
    writer
        .finish()
        .map_err(|error| format!("icon could not be written: {error}"))?;
    Ok(encoded)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_the_original_file() {
        for file in FILES {
            let original = static_assets::get(&format!("icons/{file}")).unwrap().body;

            let image = image(ServerIcon::Default, file).unwrap().unwrap();

            assert!(matches!(image, Cow::Borrowed(_)), "{file}");
            assert_eq!(&*image, original, "{file}");
        }
    }

    #[test]
    fn a_color_keeps_black_and_white_and_turns_middle_gray_into_the_color() {
        let original = encode(&[
            [0, 0, 0, 255],
            [128, 128, 128, 255],
            [255, 255, 255, 255],
            [128, 128, 128, 0],
        ]);

        let pixels = decode(&tint(&original, [0x36, 0x87, 0xE3]).unwrap()).1;

        assert_eq!(pixels[0..4], [0, 0, 0, 255]);
        for (channel, color) in pixels[4..7].iter().zip([0x36, 0x87, 0xE3]) {
            assert!(channel.abs_diff(color) <= 1, "{channel} near {color}");
        }
        assert_eq!(pixels[7], 255);
        assert_eq!(pixels[8..12], [255, 255, 255, 255]);
        assert_eq!(pixels[15], 0);
    }

    #[test]
    fn every_icon_draws_every_file_at_its_original_size() {
        let original_size =
            |file: &str| decode(static_assets::get(&format!("icons/{file}")).unwrap().body).0;
        for icon in ServerIcon::ALL {
            let image = image(icon, "icon-192.png").unwrap().unwrap();
            assert_eq!(decode(&image).0, original_size("icon-192.png"), "{icon:?}");
        }
        for file in FILES {
            let image = image(ServerIcon::Teal, file).unwrap().unwrap();
            assert_eq!(decode(&image).0, original_size(file), "{file}");
        }
    }

    #[test]
    fn an_icon_that_is_not_8_bit_rgba_is_refused() {
        let mut gray = Vec::new();
        let mut encoder = Encoder::new(&mut gray, 2, 1);
        encoder.set_color(ColorType::Grayscale);
        encoder.set_depth(BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&[0, 255]).unwrap();
        writer.finish().unwrap();

        assert_eq!(
            tint(&gray, [0x36, 0x87, 0xE3]),
            Err("icon is not 8-bit RGBA".to_string())
        );
        assert!(tint(b"not a png", [0x36, 0x87, 0xE3]).is_err());
    }

    #[test]
    fn a_file_the_server_does_not_offer_has_no_image() {
        assert!(image(ServerIcon::Red, "unknown.png").is_none());
        assert!(image(ServerIcon::Red, "../index.html").is_none());
    }

    #[test]
    fn every_color_contrasts_three_to_one_with_light_and_dark_surfaces() {
        for icon in ServerIcon::ALL {
            let Some(color) = color(icon) else {
                continue;
            };
            for surface in [[0xFF, 0xFF, 0xFF], [0x1B, 0x1B, 0x1B], [0x35, 0x36, 0x3A]] {
                let (body, ground) = (luminance(color), luminance(surface));
                let contrast = (body.max(ground) + 0.05) / (body.min(ground) + 0.05);
                assert!(contrast >= 3.0, "{icon:?} on {surface:?}: {contrast}");
            }
        }
    }

    fn luminance(color: [u8; 3]) -> f64 {
        let [red, green, blue] = color.map(|channel| {
            let channel = f64::from(channel) / 255.0;
            if channel <= 0.04045 {
                channel / 12.92
            } else {
                ((channel + 0.055) / 1.055).powf(2.4)
            }
        });
        0.2126 * red + 0.7152 * green + 0.0722 * blue
    }

    fn encode(pixels: &[[u8; 4]]) -> Vec<u8> {
        let mut encoded = Vec::new();
        let mut encoder = Encoder::new(&mut encoded, pixels.len() as u32, 1);
        encoder.set_color(ColorType::Rgba);
        encoder.set_depth(BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(pixels.as_flattened()).unwrap();
        writer.finish().unwrap();
        encoded
    }

    fn decode(png: &[u8]) -> ((u32, u32), Vec<u8>) {
        let mut reader = Decoder::new(Cursor::new(png)).read_info().unwrap();
        let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
        let frame = reader.next_frame(&mut pixels).unwrap();
        pixels.truncate(frame.buffer_size());
        ((frame.width, frame.height), pixels)
    }
}
