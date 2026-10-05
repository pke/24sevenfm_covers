#include "player_follow.h"
namespace ssc {
int playerStation(const std::string& url) {
    if (url.size() > 4096) return -1;
    std::string lower = url;
    for (char& c : lower) {
        if ((unsigned char)c <= 32 || (unsigned char)c >= 127 || c == '\\') return -1;
        c = (char)std::tolower((unsigned char)c);
    }
    size_t start = lower.compare(0, 7, "http://") == 0 ? 7 : lower.compare(0, 8, "https://") == 0 ? 8 : 0;
    if (!start) return -1;
    std::string host = lower.substr(start, lower.find_first_of("/?#", start) - start);
    size_t colon = host.find(':');
    if (colon != std::string::npos) {
        std::string port = host.substr(colon + 1);
        if (port.empty() || port.size() > 5 || port.find_first_not_of("0123456789") != std::string::npos || std::stoul(port) == 0 || std::stoul(port) > 65535) return -1;
        host.resize(colon);
    }
    if (host.empty() || host.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789.-") != std::string::npos || host.front() == '.' || host.back() == '.' || host.find("..") != std::string::npos) return -1;
    for (int i = 0; i < kStationCount; ++i) {
        const std::string stationHost = station(i).host;
        if (host == stationHost || (host.size() > stationHost.size() && host.compare(host.size() - stationHost.size(), stationHost.size(), stationHost) == 0 && host[host.size() - stationHost.size() - 1] == '.')) return i;
    }
    return -1;
}
bool validPlayerEvent(const PlayerEvent& e) {
    return (e.player == "iina" || e.player == "foobar2000") && e.sequence > 0 && e.sequence <= 9007199254740991ULL
        && static_cast<int>(e.activity)>=0 && static_cast<int>(e.activity)<=3
        && !e.session.empty() && e.session.size() <= 96 && e.session.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_") == std::string::npos
        && e.url.size() <= 4096 && e.title.size() <= 4096 && e.url.find('\0') == std::string::npos && e.title.find('\0') == std::string::npos;
}
PlayerFollow::Change PlayerFollow::apply(const PlayerEvent& e) {
    if (!validPlayerEvent(e)) return Change::Ignore;
    bool owner = player_ == e.player && session_ == e.session;
    if(!owner && (e.activity!=PlayerActivity::Start || playerStation(e.url)<0)) return Change::Ignore;
    const std::string key = e.player + "/" + e.session;
    auto found = sequences_.find(key);
    if (found != sequences_.end() && e.sequence <= found->second) return Change::Ignore;
    if (found == sequences_.end() && sequences_.size() >= 64) {
        // Retain replay protection for the current owner while aging out old windows.
        auto oldest=sequences_.begin();
        if(oldest->first==player_+"/"+session_) ++oldest;
        sequences_.erase(oldest);
    }
    sequences_[key] = e.sequence;
    if (e.activity == PlayerActivity::Stop) {
        if (!owner) return Change::Ignore;
        clear(); return Change::Hide;
    }
    if (e.activity == PlayerActivity::Pause) {
        if (!owner || paused_) return Change::Ignore;
        paused_ = true; return Change::Pause;
    }
    int next = playerStation(e.url);
    if (next < 0) {
        if (!owner) return Change::Ignore;
        clear(); return Change::Hide;
    }
    if (e.activity == PlayerActivity::Update) return owner && !paused_ && next==station_ ? Change::Update : Change::Ignore;
    bool unchanged = owner && next == station_ && !paused_;
    player_ = e.player; session_ = e.session; station_ = next; paused_ = false;
    return unchanged ? Change::Update : Change::Show;
}
void PlayerFollow::clear() { player_.clear(); session_.clear(); station_ = -1; paused_ = false; }
}
