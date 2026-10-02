#pragma once
// Native release projects set this to 0; troubleshooting builds and library
// tests can opt in with SSC_ENABLE_DEBUG_OVERLAY=1. Keep the library default
// compatible with existing diagnostic consumers.
#ifndef SSC_ENABLE_DEBUG_OVERLAY
#define SSC_ENABLE_DEBUG_OVERLAY 1
#endif
#if SSC_ENABLE_DEBUG_OVERLAY != 0 && SSC_ENABLE_DEBUG_OVERLAY != 1
#error SSC_ENABLE_DEBUG_OVERLAY must be 0 or 1
#endif
