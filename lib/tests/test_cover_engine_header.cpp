// Include first: this must be self-contained without a host's platform headers.
#include "../../shared/cover_engine.h"
#include <type_traits>

#if defined(_WIN32)
static_assert(std::is_same<CoverEngine::Settings, ssccfg::EngineSettings>::value,
              "Windows hosts retain their existing settings API");
static_assert(CoverEngine::kHeartbeat == 4, "Windows heartbeat remains available");
#else
#if defined(_WINDOWS_) || defined(SSC_D2D_RENDERER_H) || defined(SSC_WM_NEWCOVER) || defined(SSC_WM_NEWMEDIA)
#error The portable cover engine header must not expose the Windows adapter
#endif
#endif

static_assert(std::is_same<ssc::PresentationPipeline::Frame,
                          std::shared_ptr<const ssc::PreparedPresentation>>::value,
              "Portable hosts receive immutable prepared presentations");

// Exercise the actual mobile-facing settings/frame interfaces, not just an empty
// guarded header. No network, native window or renderer is needed.
ssc::FrameState portableCoverEngineHeaderCheck() {
    ssccfg::EngineSettings settings;
    ssc::PresentationController controller([] { return ssc::PresentationTime{0}; });
    controller.remainingChanged(settings.showRemaining ? 10 : -1);
    return controller.advance();
}
