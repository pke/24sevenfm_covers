// Convert the shared Windows icon (or a supplied high-resolution source image)
// into the standard macOS iconset. Preserve alpha and use the largest source rep.
import AppKit

let source = CommandLine.arguments[1]
let directory = CommandLine.arguments[2]
let data = try Data(contentsOf: URL(fileURLWithPath: source))
guard let representation = NSBitmapImageRep.imageReps(with: data).max(by: {
    $0.pixelsWide * $0.pixelsHigh < $1.pixelsWide * $1.pixelsHigh
}) else { fatalError("Cannot decode icon source: \(source)") }
let image = NSImage(size: NSSize(width: representation.pixelsWide, height: representation.pixelsHigh))
image.addRepresentation(representation)
try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
            let context = NSGraphicsContext(bitmapImageRep: bitmap) else { fatalError("Cannot allocate icon") }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        context.imageInterpolation = .high
        image.draw(in: NSRect(x: 0, y: 0, width: pixels, height: pixels),
            from: .zero, operation: .copy, fraction: 1)
        context.flushGraphics()
        NSGraphicsContext.restoreGraphicsState()
        let suffix = scale == 2 ? "@2x" : ""
        let path = "\(directory)/icon_\(size)x\(size)\(suffix).png"
        try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
    }
}
print("App icon source: \(source) (\(representation.pixelsWide)×\(representation.pixelsHigh))")
