#include "image_probe.h"
#include "../shared/image_limits.h"
#include <gdk-pixbuf/gdk-pixbuf.h>

namespace ssc {
bool decodableImage(const std::string& bytes, const std::string&) {
    if (bytes.empty() || bytes.size() > 16u * 1024u * 1024u) return false;
    struct Dimensions { bool seen = false, valid = false; } dimensions;
    auto* loader = gdk_pixbuf_loader_new();
    g_signal_connect(loader, "size-prepared", G_CALLBACK(+[](GdkPixbufLoader* source, int w, int h, gpointer data) {
        auto& d = *static_cast<Dimensions*>(data);
        d.seen = true; d.valid = w > 0 && h > 0 && coverDimsOk(w, h);
        // Bound the decoder's allocation even for rejected headers.
        if (!d.valid) gdk_pixbuf_loader_set_size(source, 1, 1);
    }), &dimensions);
    GError* error = nullptr;
    const bool wrote = gdk_pixbuf_loader_write(loader,
        reinterpret_cast<const guchar*>(bytes.data()), bytes.size(), &error);
    if (error) { g_error_free(error); error = nullptr; }
    const bool closed = gdk_pixbuf_loader_close(loader, &error);
    if (error) g_error_free(error);
    auto* pixels = gdk_pixbuf_loader_get_pixbuf(loader);
    const bool valid = wrote && closed && dimensions.seen && dimensions.valid && pixels
        && gdk_pixbuf_get_pixels(pixels);
    g_object_unref(loader);
    return valid;
}
}
