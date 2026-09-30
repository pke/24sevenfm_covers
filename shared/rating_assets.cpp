#include "rating_assets.h"
#include "../lib/image_probe.h"
#include <cstring>
#ifdef _WIN32
#include <windows.h>
#include <shlobj.h>
#pragma comment(lib, "shell32.lib")
#endif

namespace ssc {
namespace {
bool validPng(const std::string& bytes) {
    static const unsigned char signature[] = {137, 80, 78, 71, 13, 10, 26, 10};
    if (bytes.size() < 33 || bytes.size() > 65536
            || std::memcmp(bytes.data(), signature, sizeof(signature)) != 0) return false;
    const auto dimension = [&](size_t at) {
        const auto* p = reinterpret_cast<const unsigned char*>(bytes.data() + at);
        return (unsigned(p[0]) << 24) | (unsigned(p[1]) << 16) | (unsigned(p[2]) << 8) | p[3];
    };
    return dimension(16) > 0 && dimension(16) <= 512 && dimension(20) > 0
        && dimension(20) <= 512 && decodableImage(bytes);
}
#ifdef _WIN32
std::string readPng(const std::wstring& path) {
    HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_DELETE,
        nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return {};
    LARGE_INTEGER size = {};
    std::string bytes;
    if (GetFileSizeEx(file, &size) && size.QuadPart > 0 && size.QuadPart <= 65536) {
        bytes.resize(static_cast<size_t>(size.QuadPart));
        DWORD read = 0;
        if (!ReadFile(file, &bytes[0], static_cast<DWORD>(bytes.size()), &read, nullptr)
                || read != bytes.size()) bytes.clear();
    }
    CloseHandle(file);
    return bytes;
}
void writePng(const std::wstring& directory, const std::wstring& path, const std::string& bytes) {
    if (directory.empty()) return;
    SHCreateDirectoryExW(nullptr, directory.c_str(), nullptr);
    const auto temp = path + L"." + std::to_wstring(GetCurrentProcessId()) + L"."
        + std::to_wstring(GetCurrentThreadId()) + L".tmp";
    HANDLE file = CreateFileW(temp.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
        FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return;
    DWORD written = 0;
    const bool ok = WriteFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr)
        && written == bytes.size();
    CloseHandle(file);
    if (!ok || !MoveFileExW(temp.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING)) DeleteFileW(temp.c_str());
}
#endif
}

RatingAssetCache::RatingAssetCache(std::wstring directory) : directory_(std::move(directory)) {}
std::wstring RatingAssetCache::defaultDirectory() {
#ifdef _WIN32
    wchar_t path[MAX_PATH] = {};
    if (SUCCEEDED(SHGetFolderPathW(nullptr, CSIDL_LOCAL_APPDATA, nullptr, SHGFP_TYPE_CURRENT, path)))
        return std::wstring(path) + L"\\24seven.fm\\Covers\\ratings-v1";
#endif
    return {};
}
std::string RatingAssetCache::find(const Certification& certification) const {
    const auto path = ratingAssetPath(certification.country, certification.system, certification.rating);
    std::lock_guard<std::mutex> lock(mutex_);
    const auto found = pngs_.find(path);
    return found == pngs_.end() ? std::string() : found->second;
}
bool RatingAssetCache::load(const Certification& certification, const MediaResolver& resolver,
                          const std::atomic<bool>* cancel) {
    const auto path = ratingAssetPath(certification.country, certification.system, certification.rating);
    if (path.empty() || (cancel && cancel->load())) return false;
    if (!find(certification).empty()) return true;
    std::string bytes;
#ifdef _WIN32
    const auto name = path.substr(path.rfind('/') + 1);
    const auto diskPath = directory_.empty() ? std::wstring()
        : directory_ + L"\\" + std::wstring(name.begin(), name.end());
    if (!diskPath.empty()) bytes = readPng(diskPath);
    if (!bytes.empty() && !validPng(bytes)) { bytes.clear(); DeleteFileW(diskPath.c_str()); }
#endif
    if (bytes.empty()) {
        if (!resolver.downloadRatingAsset(certification, bytes, cancel) || !validPng(bytes)) return false;
        if (cancel && cancel->load()) return false;
#ifdef _WIN32
        if (!diskPath.empty()) writePng(directory_, diskPath, bytes);
#endif
    }
    if (cancel && cancel->load()) return false;
    std::lock_guard<std::mutex> lock(mutex_);
    pngs_[path] = bytes;
    return true;
}
RatingAssetCache& ratingAssets() { static RatingAssetCache cache; return cache; }
} // namespace ssc
