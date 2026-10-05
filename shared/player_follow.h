#ifndef SSC_PLAYER_FOLLOW_H
#define SSC_PLAYER_FOLLOW_H

#include "stations.h"
#include <map>
#include <cstdint>

namespace ssc {
enum class PlayerActivity { Start, Update, Pause, Stop };
struct PlayerEvent {
    std::string player, session, url, title;
    uint64_t sequence = 0;
    PlayerActivity activity = PlayerActivity::Stop;
};
int playerStation(const std::string& url);
bool validPlayerEvent(const PlayerEvent& event);
class PlayerFollow {
public:
    enum class Change { Ignore, Show, Update, Pause, Hide };
    Change apply(const PlayerEvent& event);
    int station() const { return station_; }
    bool paused() const { return paused_; }
    const std::string& player() const { return player_; }
    const std::string& session() const { return session_; }
    void clear();
private:
    std::string player_, session_;
    int station_ = -1;
    bool paused_ = false;
    std::map<std::string, uint64_t> sequences_;
};
}
#endif
