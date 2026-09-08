#include "image_probe.h"

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

bool decodableImage(const std::string& bytes) {
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
    return valid;
}

} // namespace ssc

#else
namespace ssc {
bool decodableImage(const std::string& bytes) {
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
