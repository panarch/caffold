import AppKit
import Foundation

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write(Data("usage: IconGenerator OUTPUT.png\n".utf8))
    exit(2)
}

let output = URL(fileURLWithPath: CommandLine.arguments[1])
let canvas = NSSize(width: 1024, height: 1024)
let image = NSImage(size: canvas)

func color(_ hex: UInt32) -> NSColor {
    NSColor(
        red: CGFloat((hex >> 16) & 0xff) / 255,
        green: CGFloat((hex >> 8) & 0xff) / 255,
        blue: CGFloat(hex & 0xff) / 255,
        alpha: 1
    )
}

func drawLine(
    from start: NSPoint,
    to end: NSPoint,
    width: CGFloat,
    stroke: NSColor
) {
    let path = NSBezierPath()
    path.lineWidth = width
    path.lineCapStyle = .round
    path.lineJoinStyle = .round
    path.move(to: start)
    path.line(to: end)
    stroke.setStroke()
    path.stroke()
}

image.lockFocus()

color(0x16221b).setFill()
NSBezierPath(rect: NSRect(origin: .zero, size: canvas)).fill()

NSGraphicsContext.saveGraphicsState()
let shadow = NSShadow()
shadow.shadowColor = NSColor.black.withAlphaComponent(0.58)
shadow.shadowBlurRadius = 15
shadow.shadowOffset = NSSize(width: 0, height: -16)
shadow.set()

let frame = color(0xf4f8f5)
let green = color(0x18a17e)
let brace = color(0xa8b5ad)

drawLine(from: NSPoint(x: 272, y: 232), to: NSPoint(x: 272, y: 792), width: 56, stroke: frame)
drawLine(from: NSPoint(x: 752, y: 232), to: NSPoint(x: 752, y: 792), width: 56, stroke: frame)

for y in [344, 512, 680] as [CGFloat] {
    drawLine(from: NSPoint(x: 200, y: y), to: NSPoint(x: 824, y: y), width: 48, stroke: frame)
}

drawLine(from: NSPoint(x: 272, y: 344), to: NSPoint(x: 512, y: 512), width: 40, stroke: green)
drawLine(from: NSPoint(x: 272, y: 680), to: NSPoint(x: 512, y: 512), width: 40, stroke: green)
drawLine(from: NSPoint(x: 752, y: 344), to: NSPoint(x: 512, y: 512), width: 40, stroke: brace)
drawLine(from: NSPoint(x: 752, y: 680), to: NSPoint(x: 512, y: 512), width: 40, stroke: brace)
drawLine(from: NSPoint(x: 344, y: 232), to: NSPoint(x: 680, y: 232), width: 40, stroke: brace)

for point in [
    NSPoint(x: 272, y: 232),
    NSPoint(x: 752, y: 232),
    NSPoint(x: 272, y: 792),
    NSPoint(x: 752, y: 792),
] {
    frame.setStroke()
    color(0x16221b).setFill()
    let node = NSBezierPath(ovalIn: NSRect(x: point.x - 32, y: point.y - 32, width: 64, height: 64))
    node.lineWidth = 28
    node.fill()
    node.stroke()
}

NSGraphicsContext.restoreGraphicsState()
image.unlockFocus()

guard
    let tiff = image.tiffRepresentation,
    let bitmap = NSBitmapImageRep(data: tiff),
    let png = bitmap.representation(using: .png, properties: [:])
else {
    FileHandle.standardError.write(Data("failed to render Caffold Server icon\n".utf8))
    exit(1)
}

try png.write(to: output, options: .atomic)
