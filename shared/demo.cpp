// demo.cpp - see demo.h. Win32 file IO (Windows-only, like the rest of shared/).
#include "demo.h"

#include <windows.h>

#include <algorithm>
#include <cstring>
#include <cstdlib>

namespace ssc {
namespace {

std::string demoDir() {
    char t[MAX_PATH] = {0};
    GetTempPathA(MAX_PATH, t);
    return std::string(t) + "24seven.fm-covers-demo\\";
}

bool isImage(const char* name) {
    const char* dot = strrchr(name, '.');
    return dot && (_stricmp(dot, ".jpg") == 0 || _stricmp(dot, ".jpeg") == 0 || _stricmp(dot, ".png") == 0);
}

std::string readFile(const std::string& path) {
    HANDLE h = CreateFileA(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                           OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return std::string();
    std::string out;
    char buf[65536];
    DWORD n = 0;
    while (ReadFile(h, buf, sizeof(buf), &n, nullptr) && n > 0) out.append(buf, n);
    CloseHandle(h);
    return out;
}

std::string trim(const std::string& s) {
    const size_t a = s.find_first_not_of(" \t\r\n");
    if (a == std::string::npos) return std::string();
    return s.substr(a, s.find_last_not_of(" \t\r\n") - a + 1);
}

// Split on a delimiter into up to `max` trimmed fields.
void splitTrim(const std::string& s, char delim, std::string* out, int max) {
    int fi = 0;
    size_t start = 0;
    for (size_t i = 0; i <= s.size() && fi < max; ++i) {
        if (i == s.size() || s[i] == delim) { out[fi++] = trim(s.substr(start, i - start)); start = i + 1; }
    }
}

// "Album | Track | Artist | Seconds"
void parseMeta(const std::string& line, DemoFrame& f) {
    std::string fields[4];
    splitTrim(line, '|', fields, 4);
    f.album = fields[0];
    f.track = fields[1];
    f.artist = fields[2];
    f.seconds = atoi(fields[3].c_str());
}

// Sorted list of image filenames in the demo folder.
std::vector<std::string> imageNames(const std::string& dir) {
    std::vector<std::string> names;
    WIN32_FIND_DATAA fd;
    HANDLE h = FindFirstFileA((dir + "*").c_str(), &fd);
    if (h != INVALID_HANDLE_VALUE) {
        do {
            if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && isImage(fd.cFileName))
                names.push_back(fd.cFileName);
        } while (FindNextFileA(h, &fd));
        FindClose(h);
    }
    std::sort(names.begin(), names.end());
    return names;
}

} // namespace

bool Demo::active() {
    return !imageNames(demoDir()).empty();
}

bool Demo::load() {
    frames_.clear();
    index_ = 0;
    const std::string dir = demoDir();
    const std::vector<std::string> names = imageNames(dir);

    // demo.txt: one metadata line per cover, in the same sorted order.
    std::vector<std::string> meta;
    {
        const std::string txt = readFile(dir + "demo.txt");
        size_t start = 0;
        for (size_t i = 0; i <= txt.size(); ++i)
            if (i == txt.size() || txt[i] == '\n') { meta.push_back(txt.substr(start, i - start)); start = i + 1; }
    }

    for (size_t i = 0; i < names.size(); ++i) {
        DemoFrame f;
        f.bytes = readFile(dir + names[i]);
        if (f.bytes.empty()) continue;
        if (i < meta.size() && !trim(meta[i]).empty()) parseMeta(meta[i], f);
        frames_.push_back(std::move(f));
    }
    return !frames_.empty();
}

} // namespace ssc
