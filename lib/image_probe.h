#pragma once

#include <string>

namespace ssc {

// Fully decodes bounded image bytes before a provider result enters the native
// cache. On Windows this uses an isolated WIC factory on the media worker thread;
// it therefore catches corrupt payloads in the same retry state as a failed CDN
// request instead of discovering them after the UI transition has committed.
bool decodableImage(const std::string& bytes);

} // namespace ssc
