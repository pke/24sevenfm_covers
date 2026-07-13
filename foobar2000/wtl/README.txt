WTL (Windows Template Library) 10, version 10.0.10320
Copyright (C) Microsoft Corporation. Licensed under the Microsoft Public License (Ms-PL);
see MS-PL.txt.

Vendored here as the flat header set only (the "Include" contents of the WTL
distribution) - the foobar2000 SDK's libPPUI/helpers include <atlapp.h> etc. and expect
WTL on the include path. foobar2000/wtl.props appends this directory to IncludePath at
build time, so the headers live flat in this folder (no Include/ subfolder). The
Samples/ and AppWiz/ parts of the WTL distribution are not needed and are not included.

Source: https://sourceforge.net/projects/wtl/ (also published as the NuGet package "wtl").
