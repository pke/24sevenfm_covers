#include "image_probe.h"
#include "debug_features.h"
#if SSC_ENABLE_DEBUG_OVERLAY
#include "diagnostics.h"
#endif

#if defined(_WIN32)
#include <windows.h>
#include <wincodec.h>
#include <vector>

#include "../shared/image_limits.h"

#pragma comment(lib, "windowscodecs.lib")
#pragma comment(lib, "ole32.lib")

namespace {
template <class T> void release(T*& value) { if (value) { value->Release(); value = nullptr; } }
}

namespace ssc {

bool decodableImage(const std::string& bytes, const std::string& sourceUrl) {
#if SSC_ENABLE_DEBUG_OVERLAY
    const auto started = std::chrono::steady_clock::now();
#endif
    if (bytes.empty() || bytes.size() > 16u * 1024u * 1024u || bytes.size() > MAXDWORD) return false;
    const HRESULT com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool uninitialize = com == S_OK || com == S_FALSE;
    IWICImagingFactory* factory = nullptr;
    IWICStream* stream = nullptr;
    IWICBitmapDecoder* decoder = nullptr;
    IWICBitmapFrameDecode* frame = nullptr;
    IWICFormatConverter* converter = nullptr;
    bool valid = false;
    UINT width = 0, height = 0;
    if (SUCCEEDED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                                   IID_PPV_ARGS(&factory)))
            && SUCCEEDED(factory->CreateStream(&stream))
            && SUCCEEDED(stream->InitializeFromMemory(
                reinterpret_cast<BYTE*>(const_cast<char*>(bytes.data())), (DWORD)bytes.size()))
            && SUCCEEDED(factory->CreateDecoderFromStream(stream, nullptr,
                WICDecodeMetadataCacheOnLoad, &decoder))
            && SUCCEEDED(decoder->GetFrame(0, &frame))
            && SUCCEEDED(frame->GetSize(&width, &height)) && coverDimsOk(width, height)
            && SUCCEEDED(factory->CreateFormatConverter(&converter))
            && SUCCEEDED(converter->Initialize(frame, GUID_WICPixelFormat32bppPBGRA,
                WICBitmapDitherTypeNone, nullptr, 0.0, WICBitmapPaletteTypeMedianCut))) {
        const size_t stride = static_cast<size_t>(width) * 4u;
        const size_t total = stride * static_cast<size_t>(height);
        if (stride <= MAXDWORD && total <= MAXDWORD) {
            std::vector<BYTE> pixels(total);
            valid = SUCCEEDED(converter->CopyPixels(nullptr, (UINT)stride, (UINT)total,
                                                     pixels.data()));
        }
    }
    release(converter); release(frame); release(decoder); release(stream); release(factory);
    if (uninitialize) CoUninitialize();
#if SSC_ENABLE_DEBUG_OVERLAY
    DiagnosticLog::instance().image(sourceUrl, bytes.size(), width, height,
                                    diagnosticMilliseconds(started), valid);
#endif
    return valid;
}

} // namespace ssc

#elif defined(__APPLE__)
#include "../shared/image_limits.h"
#include <ImageIO/ImageIO.h>
#include <CoreGraphics/CoreGraphics.h>

namespace ssc {
bool decodableImage(const std::string& bytes, const std::string&) {
    if (bytes.empty() || bytes.size() > 16u * 1024u * 1024u) return false;
    CFDataRef data = CFDataCreate(kCFAllocatorDefault,
        reinterpret_cast<const UInt8*>(bytes.data()), bytes.size());
    if (!data) return false;
    CGImageSourceRef source = CGImageSourceCreateWithData(data, nullptr);
    CFRelease(data);
    if (!source) return false;
    CFDictionaryRef props = CGImageSourceCopyPropertiesAtIndex(source, 0, nullptr);
    int width = 0, height = 0;
    if (props) {
        auto w = static_cast<CFNumberRef>(CFDictionaryGetValue(props, kCGImagePropertyPixelWidth));
        auto h = static_cast<CFNumberRef>(CFDictionaryGetValue(props, kCGImagePropertyPixelHeight));
        if (w) CFNumberGetValue(w, kCFNumberIntType, &width);
        if (h) CFNumberGetValue(h, kCFNumberIntType, &height);
        CFRelease(props);
    }
    bool valid = false;
    if (width > 0 && height > 0 && coverDimsOk(width, height)) {
        CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0, nullptr);
        if (image) {
            // Force pixel decoding so truncated/corrupt image data cannot pass.
            CFDataRef pixels = CGDataProviderCopyData(CGImageGetDataProvider(image));
            valid = pixels && CFDataGetLength(pixels) > 0;
            if (pixels) CFRelease(pixels);
            CGImageRelease(image);
        }
    }
    CFRelease(source);
    return valid;
}
} // namespace ssc

#elif defined(SSC_LINUX_NATIVE)
// Implemented in image_probe_linux.cpp with the system GdkPixbuf decoder.
#else
namespace ssc {
bool decodableImage(const std::string& bytes, const std::string&) {
    // The media feature is disabled until a non-Windows HTTPS/UI integration exists.
    // Keep a conservative probe for future callers rather than claiming arbitrary
    // bytes are images.
    return bytes.size() >= 8
        && ((static_cast<unsigned char>(bytes[0]) == 0x89 && bytes.compare(1, 3, "PNG") == 0)
            || (static_cast<unsigned char>(bytes[0]) == 0xff
                && static_cast<unsigned char>(bytes[1]) == 0xd8));
}
} // namespace ssc
#endif
