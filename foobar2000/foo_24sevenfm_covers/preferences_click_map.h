#pragma once
#include <functional>

// Kept independent of foobar services so the actual WTL message dispatch can be
// exercised with native controls in the regression suite.
class SscPreferencesClickMap {
public:
    explicit SscPreferencesClickMap(std::function<void(int)> clicked)
        : clicked_(clicked) { m_bMsgHandled = FALSE; }
    BEGIN_MSG_MAP_EX(SscPreferencesClickMap)
        COMMAND_CODE_HANDLER_EX(BN_CLICKED, OnControlClick)
    END_MSG_MAP()
private:
    void OnControlClick(UINT, int id, HWND) {
        // WTL passes notification code first, control ID second.
        clicked_(id);
    }
    std::function<void(int)> clicked_;
};
