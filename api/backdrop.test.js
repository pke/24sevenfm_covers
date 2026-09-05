"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
    CACHE_SECONDS,
    MISS_CACHE_SECONDS,
    backdropTitleCandidatesFor,
    backdropTitleFor,
    certificationResponse,
    cleanMovieTitle,
    createHandler,
    createTintHandler,
    mediaHintForAlbum,
    pickComposerCredit,
    pickExactPerson,
    pickGame,
    pickMedia,
    pickMovie,
    requestQueryValue,
    requestedOrientation,
    requestedRatings,
    tintFromMeans,
    tintPreviewUrl,
    trustedCoverTintUrl,
    trustedSteamGridDbUrl,
    trustedTvmazeUrl,
} = require("./_lib/backdrop");

test("normalizes the live The Wings Of A Film title in the resolver", () => {
    assert.equal(backdropTitleFor("The Wings Of A Film",
        "The Thin Red Line: Journey To The Line"), "The Thin Red Line");
    assert.equal(backdropTitleFor("The Wings Of A Film",
        "Rain Man: Main Theme"), "Rain Man");
    assert.equal(mediaHintForAlbum("The Wings Of A Film"), "movie");
    assert.equal(backdropTitleFor("Arrival (Original Motion Picture Soundtrack)",
        "Another Film: A Cue"), "Arrival");
});

test("resolves the live The Wings Of A Film album and track contract", async () => {
    let providerQuery = "";
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            providerQuery = parsed.searchParams.get("query");
            return response(200, { results: [{
                id: 8741, title: "The Thin Red Line", backdrop_path: "/thin-red-line.jpg",
            }] });
        },
        tintForImage: async () => [100, 120, 140],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "The Wings Of A Film",
        track: "The Thin Red Line: Journey To The Line",
        providers: "tmdb",
    }), res);

    assert.equal(providerQuery, "The Thin Red Line");
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 8741, title: "The Thin Red Line", type: "movie" },
        backdrop: "https://image.tmdb.org/t/p/w1280/thin-red-line.jpg",
        source: "tmdb",
        tint: [100, 120, 140],
    });
});

test("resolves the live Music For A Darkened Theatre compilation track", async () => {
    let providerQuery = "";
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            providerQuery = parsed.searchParams.get("query");
            return response(200, { results: [{
                id: 1049, title: "Sommersby", backdrop_path: "/sommersby.jpg",
            }] });
        },
        tintForImage: async () => [90, 110, 130],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Music For A Darkened Theatre, Vol. 2",
        track: "Sommersby: Return Montage",
        providers: "tmdb",
    }), res);

    assert.equal(providerQuery, "Sommersby");
    assert.equal(mediaHintForAlbum("Music For A Darkened Theatre, Vol. 2"), "movie");
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 1049, title: "Sommersby", type: "movie" },
        backdrop: "https://image.tmdb.org/t/p/w1280/sommersby.jpg",
        source: "tmdb",
        tint: [90, 110, 130],
    });
});

test("resolves Be My Love from Romantic Duets From MGM Classics", async () => {
    const providerQueries = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            providerQueries.push({
                path: parsed.pathname,
                query: parsed.searchParams.get("query"),
                year: parsed.searchParams.get("primary_release_year")
                    || parsed.searchParams.get("first_air_date_year"),
            });
            if (parsed.pathname === "/3/search/movie") {
                return response(200, { results: [{
                    id: 52847,
                    title: "The Toast of New Orleans",
                    release_date: "1950-08-24",
                    backdrop_path: "/toast-of-new-orleans.jpg",
                }] });
            }
            if (parsed.pathname === "/3/search/tv") return response(200, { results: [] });
            throw new Error("Unexpected provider URL " + parsed.href);
        },
        tintForImage: async () => [120, 100, 80],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Romantic Duets From MGM Classics",
        track: "Be My Love",
        artist: "Mario Lanza & Kathryn Grayson",
        providers: "tmdb",
    }), res);

    assert.deepEqual(providerQueries, [
        { path: "/3/search/movie", query: "The Toast of New Orleans", year: "1950" },
        { path: "/3/search/tv", query: "The Toast of New Orleans", year: "1950" },
    ]);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 52847, title: "The Toast of New Orleans", type: "movie" },
        backdrop: "https://image.tmdb.org/t/p/w1280/toast-of-new-orleans.jpg",
        source: "tmdb",
        tint: [120, 100, 80],
    });
});

test("resolves the Once More, With Feeling episode album to the Buffy TV series", async () => {
    const providerQueries = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            providerQueries.push({
                path: parsed.pathname,
                query: parsed.searchParams.get("query"),
            });
            assert.equal(parsed.pathname, "/3/search/multi");
            return response(200, { results: [{
                id: 95,
                media_type: "tv",
                name: "Buffy the Vampire Slayer",
                backdrop_path: "/buffy.jpg",
            }] });
        },
        tintForImage: async () => [80, 100, 120],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Buffy The Vampire Slayer: Once More, With Feeling",
        track: "The Parking Ticket",
        artist: "Joss Whedon",
        providers: "tmdb",
    }), res);

    assert.deepEqual(providerQueries, [{
        path: "/3/search/multi",
        query: "Buffy the Vampire Slayer",
    }]);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 95, title: "Buffy the Vampire Slayer", type: "tv" },
        backdrop: "https://image.tmdb.org/t/p/w1280/buffy.jpg",
        source: "tmdb",
        tint: [80, 100, 120],
    });
});

test("resolves the second Stranger Things score album to the TV series", async () => {
    const providerQueries = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            providerQueries.push({
                path: parsed.pathname,
                query: parsed.searchParams.get("query"),
            });
            assert.equal(parsed.pathname, "/3/search/multi");
            return response(200, { results: [{
                id: 66732,
                media_type: "tv",
                name: "Stranger Things",
                backdrop_path: "/stranger-things.jpg",
            }] });
        },
        tintForImage: async () => [120, 80, 100],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Stranger Things 2",
        track: "Looking For A Way Out",
        artist: "Kyle Dixon & Michael Stein",
        providers: "tmdb",
    }), res);

    assert.deepEqual(providerQueries, [{
        path: "/3/search/multi",
        query: "Stranger Things",
    }]);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 66732, title: "Stranger Things", type: "tv" },
        backdrop: "https://image.tmdb.org/t/p/w1280/stranger-things.jpg",
        source: "tmdb",
        tint: [120, 80, 100],
    });
});

test("resolves Songs In The Key Of Springfield to The Simpsons TV series", async () => {
    const providerQueries = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            providerQueries.push({
                path: parsed.pathname,
                query: parsed.searchParams.get("query"),
            });
            assert.equal(parsed.pathname, "/3/search/multi");
            return response(200, { results: [{
                id: 456,
                media_type: "tv",
                name: "The Simpsons",
                backdrop_path: "/simpsons.jpg",
            }] });
        },
        tintForImage: async () => [80, 100, 120],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Simpsons, The: Songs In The Key Of Springfield",
        track: "Happy Birthday, Lisa",
        artist: "Lisa/Bart/Leon Kompowski (Kipp Lennon)",
        providers: "tmdb",
    }), res);

    assert.deepEqual(providerQueries, [{
        path: "/3/search/multi",
        query: "The Simpsons",
    }]);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 456, title: "The Simpsons", type: "tv" },
        backdrop: "https://image.tmdb.org/t/p/w1280/simpsons.jpg",
        source: "tmdb",
        tint: [80, 100, 120],
    });
});

test("resolves Jazz Loves Disney's Stay Awake to Mary Poppins", async () => {
    const providerQueries = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            providerQueries.push({
                path: parsed.pathname,
                query: parsed.searchParams.get("query"),
            });
            assert.equal(parsed.pathname, "/3/search/multi");
            return response(200, { results: [{
                id: 433,
                media_type: "movie",
                title: "Mary Poppins",
                backdrop_path: "/mary-poppins.jpg",
            }] });
        },
        tintForImage: async () => [80, 100, 120],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Jazz Loves Disney 2: A Kind Of Magic",
        track: "Stay Awake",
        artist: "Laura Mvula",
        providers: "tmdb",
    }), res);

    assert.deepEqual(providerQueries, [{
        path: "/3/search/multi",
        query: "Mary Poppins",
    }]);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 433, title: "Mary Poppins", type: "movie" },
        backdrop: "https://image.tmdb.org/t/p/w1280/mary-poppins.jpg",
        source: "tmdb",
        tint: [80, 100, 120],
    });
});

test("resolves Lullaby Of The Leaves to the 1996 Kansas City film", async () => {
    const searches = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            searches.push(parsed);
            if (parsed.pathname === "/3/search/movie") return response(200, { results: [{
                id: 22479, title: "Kansas City", release_date: "1996-08-16",
                backdrop_path: "/kansas-city.jpg",
            }] });
            if (parsed.pathname === "/3/search/tv") return response(200, { results: [] });
            throw new Error("unexpected request " + parsed.href);
        },
        tintForImage: async () => [255, 234, 218],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Kansas City",
        track: "Lullaby Of The Leaves",
        artist: "Jesse Davis, Clark Gayton, Geri Allen",
        providers: "tmdb",
    }), res);

    assert.equal(searches.length, 2);
    for (const search of searches) assert.equal(search.searchParams.get("query"), "Kansas City");
    assert.equal(searches.find((search) => search.pathname.endsWith("/movie"))
        .searchParams.get("primary_release_year"), "1996");
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 22479, title: "Kansas City", type: "movie" },
        backdrop: "https://image.tmdb.org/t/p/w1280/kansas-city.jpg",
        source: "tmdb",
        tint: [255, 234, 218],
    });
});

test("resolves The Caves Of Androzani to the classic Doctor Who series", async () => {
    const providerQueries = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            providerQueries.push({
                path: parsed.pathname,
                query: parsed.searchParams.get("query"),
                year: parsed.searchParams.get("first_air_date_year"),
            });
            if (parsed.pathname === "/3/search/movie") {
                return response(200, { results: [] });
            }
            assert.equal(parsed.pathname, "/3/search/tv");
            return response(200, { results: [{
                id: 121,
                name: "Doctor Who",
                first_air_date: "1963-11-23",
                backdrop_path: "/doctor-who-classic.jpg",
            }] });
        },
        tintForImage: async () => [80, 100, 120],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Doctor Who: The 50th Anniversary Collection",
        track: "The Caves Of Androzani (Alternative Suite) "
            + "[From \"The Caves Of Androzani\"]",
        artist: "Roger Limb",
        providers: "tmdb",
    }), res);

    assert.deepEqual(providerQueries, [{
        path: "/3/search/movie", query: "Doctor Who", year: null,
    }, {
        path: "/3/search/tv", query: "Doctor Who", year: "1963",
    }]);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 121, title: "Doctor Who", type: "tv" },
        backdrop: "https://image.tmdb.org/t/p/w1280/doctor-who-classic.jpg",
        source: "tmdb",
        tint: [80, 100, 120],
    });
});

test("resolves The Snowmen soundtrack cue to the modern Doctor Who series", async () => {
    const searches = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            searches.push(parsed);
            if (parsed.pathname === "/3/search/movie") return response(200, { results: [] });
            if (parsed.pathname === "/3/search/tv") return response(200, { results: [{
                id: 57243, name: "Doctor Who", first_air_date: "2005-03-26",
                backdrop_path: "/doctor-who-modern.jpg",
            }] });
            throw new Error("unexpected request " + parsed.href);
        },
        tintForImage: async () => [156, 206, 255],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Doctor Who: The Snowmen / The Doctor, The Widow And The Wardrobe",
        track: "Clara In The Tardis (From \"The Snowmen\")",
        artist: "Murray Gold",
        providers: "tmdb",
    }), res);

    assert.equal(searches.length, 2);
    for (const search of searches) assert.equal(search.searchParams.get("query"), "Doctor Who");
    assert.equal(searches.find((search) => search.pathname.endsWith("/tv"))
        .searchParams.get("first_air_date_year"), "2005");
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 57243, title: "Doctor Who", type: "tv" },
        backdrop: "https://image.tmdb.org/t/p/w1280/doctor-who-modern.jpg",
        source: "tmdb",
        tint: [156, 206, 255],
    });
});

test("resolves the live Film Noir's Finest TV cue through its track prefix", async () => {
    let providerQuery = "";
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            providerQuery = parsed.searchParams.get("query");
            return response(200, { results: [{
                id: 713, media_type: "tv", name: "Remington Steele",
                backdrop_path: "/remington-steele.jpg",
            }] });
        },
        tintForImage: async () => [80, 100, 120],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Film Noir's Finest: Themes From The Dark Side Of The Lens",
        track: "Remington Steele - Laura's Theme",
        providers: "tmdb",
    }), res);

    assert.equal(providerQuery, "Remington Steele");
    assert.equal(mediaHintForAlbum(
        "Film Noir's Finest: Themes From The Dark Side Of The Lens"), "screen");
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 713, title: "Remington Steele", type: "tv" },
        backdrop: "https://image.tmdb.org/t/p/w1280/remington-steele.jpg",
        source: "tmdb",
        tint: [80, 100, 120],
    });
});

test("extracts a trailing TV season marker without a title-specific exception", () => {
    assert.equal(backdropTitleFor("Doctor Who: Series 9",
        "We Need To Get Back To The Tardis"), "Doctor Who");
    assert.equal(backdropTitleFor("The Crown - Season 3", "Olding"), "The Crown");
    assert.equal(backdropTitleFor("Dark – Staffel 2", "Anfänge und Enden"), "Dark");
    assert.equal(mediaHintForAlbum("Doctor Who: Series 9"), "tv");
    assert.equal(mediaHintForAlbum("The Crown - Season 3"), "tv");
    assert.equal(mediaHintForAlbum("Dark – Staffel 2"), "tv");
    assert.equal(backdropTitleFor("Series 7: The Contenders", "Opening"),
        "Series 7: The Contenders");
});

test("extracts a TV book soundtrack suffix and rotates its title article", () => {
    const album = "Legend Of Korra, The: Original Music From Book One";
    assert.equal(backdropTitleFor(album, "Korra Airbends"), "The Legend Of Korra");
    assert.equal(mediaHintForAlbum(album), "tv");
});

test("resolves a TV book soundtrack to its series", async () => {
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            assert.equal(parsed.pathname, "/3/search/multi");
            assert.equal(parsed.searchParams.get("query"), "The Legend Of Korra");
            return response(200, { results: [{
                id: 33880, media_type: "tv", name: "The Legend of Korra",
                first_air_date: "2012-04-14", backdrop_path: "/korra.jpg",
            }] });
        },
        tintForImage: async () => [91, 111, 131],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Legend Of Korra, The: Original Music From Book One",
        track: "Korra Airbends",
        providers: "tmdb",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 33880, title: "The Legend of Korra", type: "tv" },
        backdrop: "https://image.tmdb.org/t/p/w1280/korra.jpg",
        source: "tmdb",
        tint: [91, 111, 131],
    });
});

test("removes parenthesized soundtrack volumes from animated series titles", () => {
    assert.equal(cleanMovieTitle("Green Lantern: The Animated Series (Volume Two)"),
        "Green Lantern: The Animated Series");
    assert.equal(cleanMovieTitle("Green Lantern: The Animated Series (Vol. 2)"),
        "Green Lantern: The Animated Series");
    assert.equal(mediaHintForAlbum("Green Lantern: The Animated Series (Volume Two)"), "tv");
    assert.equal(backdropTitleFor("Green Lantern: The Animated Series (Volume Two)",
        "Dawn Of Time"), "Green Lantern: The Animated Series");
});

test("resolves an animated-series soundtrack volume as TV", async () => {
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            assert.equal(parsed.pathname, "/3/search/multi");
            assert.equal(parsed.searchParams.get("query"),
                "Green Lantern: The Animated Series");
            return response(200, { results: [{
                id: 40351, media_type: "tv", name: "Green Lantern: The Animated Series",
                backdrop_path: "/green-lantern.jpg",
            }] });
        },
        tintForImage: async () => [119, 255, 156],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Green Lantern: The Animated Series (Volume Two)",
        track: "Dawn Of Time",
        providers: "tmdb",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 40351, title: "Green Lantern: The Animated Series", type: "tv" },
        backdrop: "https://image.tmdb.org/t/p/w1280/green-lantern.jpg",
        source: "tmdb",
        tint: [119, 255, 156],
    });
});

test("uses the composer to disambiguate a season-marked TV series", async () => {
    let titleQuery = "";
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            if (parsed.pathname === "/3/search/multi") {
                titleQuery = parsed.searchParams.get("query");
                return response(200, { results: [
                    { id: 121, media_type: "tv", name: "Doctor Who",
                        first_air_date: "1963-11-23", backdrop_path: "/classic.jpg" },
                    { id: 57243, media_type: "tv", name: "Doctor Who",
                        first_air_date: "2005-03-26", backdrop_path: "/modern.jpg" },
                ] });
            }
            if (parsed.pathname === "/3/search/person") return response(200, { results: [{
                id: 2428, name: "Murray Gold", known_for_department: "Sound",
            }] });
            if (parsed.pathname === "/3/person/2428/combined_credits") {
                return response(200, { crew: [{
                    id: 57243, media_type: "tv", name: "Doctor Who",
                    job: "Original Music Composer", backdrop_path: "/modern.jpg",
                }] });
            }
            throw new Error("unexpected request " + parsed.href);
        },
        tintForImage: async () => [80, 100, 120],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Doctor Who: Series 9",
        track: "We Need To Get Back To The Tardis",
        artist: "Murray Gold",
        providers: "tmdb",
    }), res);

    assert.equal(titleQuery, "Doctor Who");
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 57243, title: "Doctor Who", type: "tv" },
        backdrop: "https://image.tmdb.org/t/p/w1280/modern.jpg",
        source: "tmdb",
        tint: [80, 100, 120],
    });
});

test("normalizes only explicitly prefixed Star Trek series aliases", () => {
    assert.equal(backdropTitleFor(
        "Star Trek, TNG Vol. 2, Best Of Both Worlds", "First Attack"),
    "Star Trek: The Next Generation");
    assert.equal(backdropTitleFor("Star Trek, DS9 Vol. 1", "The Emissary"),
        "Star Trek: Deep Space Nine");
    assert.equal(backdropTitleFor("Star Trek - VOY Collection", "Caretaker"),
        "Star Trek: Voyager");
    assert.equal(mediaHintForAlbum("Star Trek, TNG Vol. 2, Best Of Both Worlds"), "tv");
    assert.equal(backdropTitleFor("Star Trek: The Motion Picture", "Main Title"),
        "Star Trek: The Motion Picture");
    assert.equal(backdropTitleFor("TNG Vol. 2", "First Attack"), "TNG Vol. 2");
});

test("resolves the live abbreviated Star Trek album as The Next Generation", async () => {
    let providerQuery = "";
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            providerQuery = parsed.searchParams.get("query");
            return response(200, { results: [{
                id: 655, media_type: "tv", name: "Star Trek: The Next Generation",
                backdrop_path: "/next-generation.jpg",
            }] });
        },
        tintForImage: async () => [80, 100, 120],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Star Trek, TNG Vol. 2, Best Of Both Worlds",
        track: "First Attack",
        providers: "tmdb",
    }), res);

    assert.equal(providerQuery, "Star Trek: The Next Generation");
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 655, title: "Star Trek: The Next Generation", type: "tv" },
        backdrop: "https://image.tmdb.org/t/p/w1280/next-generation.jpg",
        source: "tmdb",
        tint: [80, 100, 120],
    });
});

test("returns German and US movie ratings without resolving artwork", async () => {
    const requests = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            requests.push(parsed.pathname);
            if (parsed.pathname === "/3/search/multi") return response(200, { results: [{
                id: 293863, media_type: "movie", title: "The Age of Adaline",
                backdrop_path: "/adaline.jpg",
            }] });
            if (parsed.pathname === "/3/movie/293863/release_dates") return response(200, {
                results: [
                    { iso_3166_1: "DE", release_dates: [
                        { certification: "12", type: 4 },
                        { certification: "6", type: 3 },
                    ] },
                    { iso_3166_1: "US", release_dates: [
                        { certification: "PG-13", type: 3 },
                    ] },
                ],
            });
            throw new Error("unexpected request " + parsed.href);
        },
        tintForImage: async () => { throw new Error("must not resolve tint"); },
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Age Of Adaline, The", providers: "tmdb", ratings: "DE,US", art: "0",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 293863, title: "The Age of Adaline", type: "movie" },
        backdrop: null,
        source: null,
        tint: [255, 255, 255],
        certifications: [
            {
                country: "DE", system: "FSK", rating: "6", label: "FSK 6",
                logo: "https://upload.wikimedia.org/wikipedia/commons/b/b0/FSK_ab_6_logo.svg",
            },
            {
                country: "US", system: "MPA", rating: "PG-13", label: "PG-13",
                logo: "https://upload.wikimedia.org/wikipedia/commons/9/98/MPA_PG-13_RATING.svg",
            },
        ],
    });
    assert.deepEqual(requests, ["/3/search/multi", "/3/movie/293863/release_dates"]);
    assert.equal(res.headers.get("cache-control"), "public, max-age=" + CACHE_SECONDS
        + ", s-maxage=" + CACHE_SECONDS + ", stale-while-revalidate=86400");
});

test("returns Game of Thrones German and US TV ratings", async () => {
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            if (parsed.pathname === "/3/search/multi") return response(200, { results: [{
                id: 1399, media_type: "tv", name: "Game of Thrones",
                backdrop_path: "/game-of-thrones.jpg",
            }] });
            if (parsed.pathname === "/3/tv/1399/content_ratings") return response(200, {
                results: [
                    { iso_3166_1: "DE", rating: "16" },
                    { iso_3166_1: "US", rating: "TV-MA",
                        descriptors: ["V", "S", "L", "D", "V", "unknown"] },
                ],
            });
            throw new Error("unexpected request " + parsed.href);
        },
        tintForImage: async () => { throw new Error("must not resolve tint"); },
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Game Of Thrones", providers: "tmdb", ratings: "DE,US", art: "0",
    }), res);

    assert.deepEqual(JSON.parse(res.body).certifications, [
        {
            country: "DE", system: "FSK", rating: "16", label: "FSK 16",
            logo: "https://upload.wikimedia.org/wikipedia/commons/3/30/FSK_16.svg",
        },
        {
            country: "US", system: "TV Parental Guidelines", rating: "TV-MA", label: "TV-MA",
            logo: "https://upload.wikimedia.org/wikipedia/commons/3/34/TV-MA_icon.svg",
            descriptors: ["L", "S", "V"],
        },
    ]);
});

test("keeps backdrop artwork available when the rating lookup fails", async () => {
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            if (parsed.pathname === "/3/search/multi") return response(200, { results: [{
                id: 329865, media_type: "movie", title: "Arrival", backdrop_path: "/arrival.jpg",
            }] });
            if (parsed.pathname === "/3/movie/329865/release_dates") return response(503, {});
            throw new Error("unexpected request " + parsed.href);
        },
        tintForImage: async () => [10, 20, 30],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Arrival", providers: "tmdb", ratings: "DE,US",
    }), res);

    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 329865, title: "Arrival", type: "movie" },
        backdrop: "https://image.tmdb.org/t/p/w1280/arrival.jpg",
        source: "tmdb",
        tint: [10, 20, 30],
        certifications: [],
    });
});

test("uses the composer to disambiguate exact movie and TV titles", async () => {
    const requests = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            requests.push(parsed.pathname);
            if (parsed.pathname === "/3/search/multi") return response(200, { results: [
                { id: 95543, media_type: "tv", name: "The Rocketeer",
                    backdrop_path: "/rocketeer-tv.jpg" },
                { id: 10249, media_type: "movie", title: "The Rocketeer",
                    backdrop_path: "/rocketeer-movie.jpg" },
            ] });
            if (parsed.pathname === "/3/search/person") return response(200, { results: [{
                id: 153, name: "James Horner", known_for_department: "Sound",
            }] });
            if (parsed.pathname === "/3/person/153/combined_credits") {
                return response(200, { crew: [{
                    id: 10249, media_type: "movie", title: "The Rocketeer",
                    job: "Original Music Composer", backdrop_path: "/rocketeer-movie.jpg",
                }] });
            }
            if (parsed.pathname === "/3/movie/10249/release_dates") {
                return response(200, { results: [] });
            }
            throw new Error("unexpected request " + parsed.href);
        },
        tintForImage: async () => [80, 100, 120],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Rocketeer, The",
        track: "Main Title/Takeoff",
        artist: "James Horner",
        providers: "tmdb",
        ratings: "DE,US",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 10249, title: "The Rocketeer", type: "movie" },
        backdrop: "https://image.tmdb.org/t/p/w1280/rocketeer-movie.jpg",
        source: "tmdb",
        tint: [80, 100, 120],
        certifications: [],
    });
    assert.equal(requests.includes("/3/person/153/combined_credits"), true);
    assert.equal(requests.includes("/3/tv/95543/content_ratings"), false);
});

test("validates the requested rating countries", () => {
    assert.deepEqual(requestedRatings(undefined), []);
    assert.deepEqual(requestedRatings("de,US,DE"), ["DE", "US"]);
    assert.throws(() => requestedRatings("GB"), /ratings must contain DE and\/or US/);
});

test("maps every supported FSK, MPA, and US TV rating to its Wikimedia SVG", () => {
    const movieLogos = {
        "DE|0": "https://upload.wikimedia.org/wikipedia/commons/1/17/FSK_0.svg",
        "DE|6": "https://upload.wikimedia.org/wikipedia/commons/b/b0/FSK_ab_6_logo.svg",
        "DE|12": "https://upload.wikimedia.org/wikipedia/commons/6/6e/FSK_12.svg",
        "DE|16": "https://upload.wikimedia.org/wikipedia/commons/3/30/FSK_16.svg",
        "DE|18": "https://upload.wikimedia.org/wikipedia/commons/5/5d/FSK_18.svg",
        "US|G": "https://upload.wikimedia.org/wikipedia/commons/4/4f/MPA_G_RATING.svg",
        "US|PG": "https://upload.wikimedia.org/wikipedia/commons/9/9a/MPA_PG_RATING.svg",
        "US|PG-13": "https://upload.wikimedia.org/wikipedia/commons/9/98/MPA_PG-13_RATING.svg",
        "US|R": "https://upload.wikimedia.org/wikipedia/commons/6/6b/MPA_R_RATING.svg",
        "US|NC-17": "https://upload.wikimedia.org/wikipedia/commons/c/c0/MPA_NC-17_RATING.svg",
    };
    for (const [key, logo] of Object.entries(movieLogos)) {
        const [country, rating] = key.split("|");
        assert.equal(certificationResponse(country, rating, "movie").logo, logo);
    }
    const tvLogos = {
        "TV-Y": "https://upload.wikimedia.org/wikipedia/commons/2/25/TV-Y_icon.svg",
        "TV-Y7": "https://upload.wikimedia.org/wikipedia/commons/5/5a/TV-Y7_icon.svg",
        "TV-Y7-FV": "https://upload.wikimedia.org/wikipedia/commons/a/ac/TV-Y7-FV_icon.svg",
        "TV-G": "https://upload.wikimedia.org/wikipedia/commons/5/5e/TV-G_icon.svg",
        "TV-PG": "https://upload.wikimedia.org/wikipedia/commons/9/9a/TV-PG_icon.svg",
        "TV-14": "https://upload.wikimedia.org/wikipedia/commons/c/c3/TV-14_icon.svg",
        "TV-MA": "https://upload.wikimedia.org/wikipedia/commons/3/34/TV-MA_icon.svg",
    };
    for (const [rating, logo] of Object.entries(tvLogos)) {
        assert.equal(certificationResponse("US", rating, "tv").logo, logo);
    }
    assert.deepEqual(certificationResponse("US", "TV-Y7-FV", "tv").descriptors, ["FV"]);
    assert.deepEqual(certificationResponse("US", "TV-PG", "tv",
        ["v", "D", "X", "D"]).descriptors, ["D", "V"]);
    assert.equal(certificationResponse("US", "NR", "movie").logo, null);
    assert.equal(certificationResponse("US", "TV-NR", "tv").logo, null);
});

test("resolves The Dune Sketchbook through Hans Zimmer composer credits", async () => {
    const requests = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            requests.push(parsed.pathname);
            if (parsed.pathname === "/3/search/multi") {
                assert.equal(parsed.searchParams.get("query"), "The Dune Sketchbook");
                return response(200, { results: [] });
            }
            if (parsed.pathname === "/3/search/person") {
                assert.equal(parsed.searchParams.get("query"), "Hans Zimmer");
                return response(200, { results: [{ id: 947, name: "Hans Zimmer" }] });
            }
            if (parsed.pathname === "/3/person/947/combined_credits") {
                return response(200, { crew: [{
                    id: 438631, media_type: "movie", title: "Dune",
                    job: "Original Music Composer", backdrop_path: "/dune.jpg",
                }] });
            }
            throw new Error("unexpected request " + parsed.href);
        },
        tintForImage: async () => [214, 190, 155],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "The Dune Sketchbook", track: "House Atreides",
        artist: "Hans Zimmer", providers: "tmdb",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 438631, title: "Dune", type: "movie" },
        backdrop: "https://image.tmdb.org/t/p/w1280/dune.jpg",
        source: "tmdb",
        tint: [214, 190, 155],
    });
    assert.deepEqual(new Set(requests), new Set([
        "/3/search/multi", "/3/search/person", "/3/person/947/combined_credits",
    ]));
});

test("keeps an exact title match ahead of composer-credit fallback", async () => {
    let combinedCreditRequests = 0;
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            if (parsed.pathname === "/3/search/multi") return response(200, { results: [{
                id: 329865, media_type: "movie", title: "Arrival", backdrop_path: "/arrival.jpg",
            }] });
            if (parsed.pathname === "/3/search/person") {
                return response(200, { results: [{ id: 19099, name: "Jóhann Jóhannsson" }] });
            }
            if (parsed.pathname.includes("/combined_credits")) combinedCreditRequests++;
            throw new Error("unexpected request " + parsed.href);
        },
        tintForImage: async () => [100, 110, 120],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Arrival", artist: "Jóhann Jóhannsson", providers: "tmdb",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).media.title, "Arrival");
    assert.equal(combinedCreditRequests, 0);
});

function response(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    };
}

function mockRequest(query = {}, extras = {}) {
    return {
        method: extras.method || "GET",
        headers: extras.headers || {},
        url: extras.url,
        query,
    };
}

function mockResponse() {
    const headers = new Map();
    return {
        headers,
        statusCode: 0,
        body: "",
        setHeader(name, value) { headers.set(name.toLowerCase(), String(value)); },
        end(value = "") { this.body = String(value); },
    };
}

test("cleans soundtrack noise and rotated articles", () => {
    assert.equal(cleanMovieTitle("Good, The Bad & The Ugly, The (Original Motion Picture Soundtrack)"),
        "The Good, The Bad and The Ugly");
    assert.equal(cleanMovieTitle("Princess Mononoke: Symphonic Suite"), "Princess Mononoke");
    assert.equal(cleanMovieTitle("Thomas Crown Affair, The (1968)"),
        "The Thomas Crown Affair (1968)");
    assert.equal(cleanMovieTitle("Elder Scrolls V, The: Skyrim"),
        "The Elder Scrolls V: Skyrim");
    assert.equal(cleanMovieTitle("Example, A — Subtitle"), "A Example — Subtitle");
    assert.equal(cleanMovieTitle("Paris, Texas"), "Paris, Texas");
    assert.equal(cleanMovieTitle("The Magic Of Inspector Morse"), "Inspector Morse");
    assert.equal(cleanMovieTitle("Defiance (Video Game)"), "Defiance");
});

test("removes a bracketed soundtrack edition before resolving the movie", async () => {
    const album = "Close Encounters Of The Third Kind [Collector's Edition]";
    const track = "The Visitors/Bye/End Titles: The Special Edition";
    assert.equal(cleanMovieTitle(album), "Close Encounters Of The Third Kind");
    assert.equal(backdropTitleFor(album, track), "Close Encounters Of The Third Kind");

    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            assert.equal(parsed.pathname, "/3/search/multi");
            assert.equal(parsed.searchParams.get("query"),
                "Close Encounters Of The Third Kind");
            return response(200, { results: [{
                id: 840, media_type: "movie", title: "Close Encounters of the Third Kind",
                release_date: "1977-12-14", backdrop_path: "/close-encounters.jpg",
            }] });
        },
        tintForImage: async () => [212, 206, 255],
    });
    const res = mockResponse();
    await handler(mockRequest({ album, track, providers: "tmdb" }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 840, title: "Close Encounters of the Third Kind", type: "movie" },
        backdrop: "https://image.tmdb.org/t/p/w1280/close-encounters.jpg",
        source: "tmdb",
        tint: [212, 206, 255],
    });
});

test("resolves a quoted Original Music from album title as the exact game", async () => {
    const album = 'Sugaan Essena (Original Music from "Star Wars Jedi: Fallen Order")';
    const requests = [];
    assert.equal(backdropTitleFor(album, "Sugaan Essena"),
        "Star Wars Jedi: Fallen Order");

    const handler = createHandler({
        env: {
            TMDB_API_KEY: "tmdb-key",
            FANART_API_KEY: "fanart-key",
            STEAMGRIDDB_API_KEY: "sgdb-key",
        },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            requests.push(parsed.href);
            if (parsed.pathname === "/3/search/multi") {
                assert.equal(parsed.searchParams.get("query"),
                    "Star Wars Jedi: Fallen Order");
                return response(200, { results: [] });
            }
            if (parsed.pathname === "/3/search/person") return response(200, { results: [] });
            if (parsed.pathname.endsWith(
                "/search/autocomplete/Star%20Wars%20Jedi%3A%20Fallen%20Order")) {
                return response(200, { success: true, data: [{
                    id: 5254,
                    name: "Star Wars Jedi: Fallen Order",
                    verified: true,
                }] });
            }
            if (parsed.pathname === "/api/v2/heroes/game/5254") return response(200, {
                success: true,
                data: [{
                    score: 10,
                    url: "https://cdn2.steamgriddb.com/hero/fallen-order.jpg",
                    thumb: "https://cdn2.steamgriddb.com/hero_thumb/fallen-order.jpg",
                }],
            });
            throw new Error("unexpected request " + parsed.href);
        },
        tintForImage: async () => [210, 222, 255],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album,
        track: "Sugaan Essena",
        artist: "HU, The",
        providers: "fanart,tmdb,tvmaze,steamgriddb",
        ratings: "DE,US",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 5254, title: "Star Wars Jedi: Fallen Order", type: "game" },
        backdrop: "https://cdn2.steamgriddb.com/hero/fallen-order.jpg",
        source: "steamgriddb",
        tint: [210, 222, 255],
        certifications: [],
    });
    assert.equal(requests.some((url) => url.includes("/heroes/game/5254")), true);
});

test("infers only explicit game, movie, and TV soundtrack markers", () => {
    assert.equal(mediaHintForAlbum("Hades (Original Video Game Soundtrack)"), "game");
    assert.equal(mediaHintForAlbum("Journey - Music From The Video Game"), "game");
    assert.equal(mediaHintForAlbum("Video Games Live: Level 2"), "game");
    assert.equal(mediaHintForAlbum("Defiance (Video Game)"), "game");
    assert.equal(mediaHintForAlbum("Arrival (Original Motion Picture Soundtrack)"), "movie");
    assert.equal(mediaHintForAlbum("Doctor Who (Original Television Soundtrack)"), "tv");
    assert.equal(mediaHintForAlbum("Prey"), "auto");
});

test("decodes local Vercel plus-spaces without losing encoded literal plus signs", () => {
    assert.equal(requestQueryValue({
        url: "/api/backdrop",
        query: { album: "Defiance+(Video+Game)" },
    }, "album"), "Defiance (Video Game)");
    assert.equal(requestQueryValue({
        url: "/api/backdrop?album=C%2B%2B",
        query: { album: "C++" },
    }, "album"), "C++");
});

test("uses the track title for a Video Games Live compilation", () => {
    assert.equal(backdropTitleFor("Video Games Live: Level 2",
        "The Legend Of Zelda Suite"), "The Legend Of Zelda");
    assert.equal(backdropTitleFor("Video Games Live: Level 5",
        "Phoenix Wright"), "Phoenix Wright");
});

test("uses a conservative SteamGridDB title extension for game compilations", () => {
    const results = [
        { id: 1, name: "Phoenix Wright: Ace Attorney - Justice For All", verified: true },
        { id: 2, name: "Phoenix Wright: Ace Attorney", verified: true },
        { id: 3, name: "Professor Layton vs. Phoenix Wright: Ace Attorney", verified: true },
    ];
    assert.equal(pickGame(results, "Phoenix Wright"), null);
    assert.equal(pickGame(results, "Phoenix Wright", { allowPrefix: true }), results[1]);
    assert.equal(pickGame([{ id: 4, name: "Doom II", verified: true }],
        "Doom", { allowPrefix: true }), null);
});

test("uses an exact base game only for an explicitly named DLC pack", () => {
    const stellaris = { id: 3924, name: "Stellaris", verified: true };
    assert.equal(pickGame([stellaris], "Stellaris: Humanoids Species Pack"), stellaris);
    assert.equal(pickGame([stellaris], "Stellaris: Galactic Paragons"), null);
});

test("matches spelled-out And against a provider ampersand", () => {
    const conker = { id: 5256835, name: "Conker: Live & Reloaded", verified: true };
    assert.equal(pickGame([conker], "Conker: Live And Reloaded"), conker);
});

test("uses exact TV-title prefixes for a Great British TV Themes track", () => {
    assert.equal(mediaHintForAlbum("Great British TV Themes"), "tv");
    assert.deepEqual(backdropTitleCandidatesFor("Great British TV Themes",
        "The Protectors Avenues And Alleyways"), [
        "The Protectors Avenues And Alleyways",
        "The Protectors Avenues And",
        "The Protectors Avenues",
        "The Protectors",
    ]);
    assert.deepEqual(backdropTitleCandidatesFor("Great British TV Themes",
        "The Protectors - Avenues And Alleyways"), ["The Protectors"]);
});

test("uses track titles for Television's Greatest Hits volumes", () => {
    const album = "Television's Greatest Hits 1, From The 50's And 60's";
    assert.equal(mediaHintForAlbum(album), "tv");
    assert.equal(backdropTitleFor(album, "Surfside 6"), "Surfside 6");
    assert.equal(mediaHintForAlbum("Television's Greatest Hits 2, From The 50's And 60's"),
        "tv");
});

test("recognizes Theme(s) From compilations without an album-name exception", () => {
    assert.equal(mediaHintForAlbum("Cinema Classics: Themes From The Screen"), "screen");
    assert.deepEqual(backdropTitleCandidatesFor("Cinema Classics: Themes From The Screen",
        "Casablanca - As Time Goes By"), ["Casablanca"]);
    assert.equal(backdropTitleFor("Arrival", "Remington Steele - Laura's Theme"), "Arrival");
});

test("recognizes Music For Film compilations through their track prefix", () => {
    assert.equal(mediaHintForAlbum("Elliot Goldenthal - Music For Film"), "screen");
    assert.deepEqual(backdropTitleCandidatesFor("Elliot Goldenthal - Music For Film",
        "Interview With The Vampire - Born To Darkness / Louis' Revenge"),
    ["Interview With The Vampire"]);
    assert.equal(backdropTitleFor("Elliot Goldenthal", "Interview With The Vampire - Cue"),
        "Elliot Goldenthal");
});

test("uses a quoted From credit as the track's screen work", () => {
    const album = "Imitation Games";
    const track = 'Redeeming Love Theme (From "Redeeming Love")';
    assert.equal(backdropTitleFor(album, track), "Redeeming Love");
    assert.deepEqual(backdropTitleCandidatesFor(album, track), ["Redeeming Love"]);
});

test("uses an explicit TV-series theme description as the screen work", () => {
    const album = "Music Of DC Comics, The: Volume 2";
    const track = "Wonder Woman Tv Series Season 3 Theme (1978)";
    assert.equal(backdropTitleFor(album, track), "Wonder Woman");
    assert.deepEqual(backdropTitleCandidatesFor(album, track), ["Wonder Woman"]);
});

test("resolves a quoted From credit as an exact screen title", async () => {
    const requests = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-key", STEAMGRIDDB_API_KEY: "steam-key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            requests.push(parsed.hostname);
            assert.equal(parsed.hostname, "api.themoviedb.org");
            assert.equal(parsed.pathname, "/3/search/multi");
            assert.equal(parsed.searchParams.get("query"), "Redeeming Love");
            return response(200, { results: [{
                id: 698508, media_type: "movie", title: "Redeeming Love",
                release_date: "2022-01-21", backdrop_path: "/redeeming-love.jpg",
            }] });
        },
        tintForImage: async () => [255, 208, 185],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Imitation Games",
        track: 'Redeeming Love Theme (From "Redeeming Love")',
        providers: "steamgriddb,tmdb",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(requests, ["api.themoviedb.org"]);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 698508, title: "Redeeming Love", type: "movie" },
        backdrop: "https://image.tmdb.org/t/p/w1280/redeeming-love.jpg",
        source: "tmdb",
        tint: [255, 208, 185],
    });
});

test("uses the work title carried by Every Note Paints A Picture tracks", () => {
    assert.equal(mediaHintForAlbum("Every Note Paints A Picture"), "screen");
    assert.deepEqual(backdropTitleCandidatesFor("Every Note Paints A Picture", "Wilde"),
        ["Wilde"]);
});

test("uses track titles for Sci-Fi's Greatest Hits volumes", () => {
    const album = "Sci-Fi's Greatest Hits, Vol. 1 - Final Frontiers";
    assert.equal(mediaHintForAlbum(album), "screen");
    assert.deepEqual(backdropTitleCandidatesFor(album, "Blade Runner"),
        ["Blade Runner"]);
});

test("resolves a Film Music (Isham) track as screen media", async () => {
    const providerQueries = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            if (parsed.pathname === "/3/search/person") {
                return response(200, { results: [] });
            }
            providerQueries.push({
                path: parsed.pathname,
                query: parsed.searchParams.get("query"),
            });
            assert.equal(parsed.pathname, "/3/search/multi");
            return response(200, { results: [{
                id: 31955,
                media_type: "movie",
                title: "Mrs. Soffel",
                backdrop_path: "/mrs-soffel.jpg",
            }] });
        },
        tintForImage: async () => [100, 110, 120],
    });
    const res = mockResponse();
    const album = "Film Music (Isham)";
    const track = "Mrs. Soffel";
    assert.equal(mediaHintForAlbum(album), "screen");
    assert.deepEqual(backdropTitleCandidatesFor(album, track), [track]);

    await handler(mockRequest({
        album,
        track,
        artist: "Mark Isham",
        providers: "tmdb",
    }), res);

    assert.deepEqual(providerQueries, [{
        path: "/3/search/multi",
        query: "Mrs. Soffel",
    }]);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 31955, title: "Mrs. Soffel", type: "movie" },
        backdrop: "https://image.tmdb.org/t/p/w1280/mrs-soffel.jpg",
        source: "tmdb",
        tint: [100, 110, 120],
    });
});

test("resolves a Sci-Fi's Greatest Hits track as screen media", async () => {
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            assert.equal(parsed.pathname, "/3/search/multi");
            assert.equal(parsed.searchParams.get("query"), "Blade Runner");
            return response(200, { results: [{
                id: 78, media_type: "movie", title: "Blade Runner",
                release_date: "1982-06-25", backdrop_path: "/blade-runner.jpg",
            }] });
        },
        tintForImage: async () => [111, 121, 131],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Sci-Fi's Greatest Hits, Vol. 1 - Final Frontiers",
        track: "Blade Runner",
        providers: "tmdb",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 78, title: "Blade Runner", type: "movie" },
        backdrop: "https://image.tmdb.org/t/p/w1280/blade-runner.jpg",
        source: "tmdb",
        tint: [111, 121, 131],
    });
});

test("resolves an Every Note Paints A Picture work as screen media", async () => {
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            assert.equal(parsed.pathname, "/3/search/multi");
            assert.equal(parsed.searchParams.get("query"), "Wilde");
            return response(200, { results: [{
                id: 11365, media_type: "movie", title: "Wilde",
                release_date: "1997-09-01", backdrop_path: "/wilde.jpg",
            }] });
        },
        tintForImage: async () => [141, 151, 161],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Every Note Paints A Picture",
        track: "Wilde",
        artist: "Debbie Wiseman",
        providers: "tmdb",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 11365, title: "Wilde", type: "movie" },
        backdrop: "https://image.tmdb.org/t/p/w1280/wilde.jpg",
        source: "tmdb",
        tint: [141, 151, 161],
    });
});

test("uses the composer to disambiguate a Music For Film compilation track", async () => {
    const requests = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            requests.push(parsed.pathname);
            if (parsed.pathname === "/3/search/multi") return response(200, { results: [
                { id: 128098, media_type: "tv", name: "Interview with the Vampire",
                    backdrop_path: "/interview-tv.jpg" },
                { id: 628, media_type: "movie", title: "Interview with the Vampire",
                    backdrop_path: "/interview-movie.jpg" },
            ] });
            if (parsed.pathname === "/3/search/person") return response(200, { results: [{
                id: 1441, name: "Elliot Goldenthal", known_for_department: "Sound",
            }] });
            if (parsed.pathname === "/3/person/1441/combined_credits") {
                return response(200, { crew: [{
                    id: 628, media_type: "movie", title: "Interview with the Vampire",
                    job: "Original Music Composer", backdrop_path: "/interview-movie.jpg",
                }] });
            }
            throw new Error("unexpected request " + parsed.href);
        },
        tintForImage: async () => [90, 70, 60],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Elliot Goldenthal - Music For Film",
        track: "Interview With The Vampire - Born To Darkness / Louis' Revenge",
        artist: "Elliot Goldenthal",
        providers: "tmdb",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 628, title: "Interview with the Vampire", type: "movie" },
        backdrop: "https://image.tmdb.org/t/p/w1280/interview-movie.jpg",
        source: "tmdb",
        tint: [90, 70, 60],
    });
    assert.deepEqual(new Set(requests), new Set([
        "/3/search/multi", "/3/search/person", "/3/person/1441/combined_credits",
    ]));
});

test("uses a game's release year to disambiguate exact SteamGridDB names", () => {
    const oldGame = { id: 1, name: "Prey", release_date: 1147392000, verified: true };
    const newGame = { id: 2, name: "Prey", release_date: 1487894400, verified: false };
    assert.equal(pickGame([oldGame, newGame], "Prey (2017)"), newGame);
});

test("prefers an exact title over a more popular partial match", () => {
    const exact = { id: 2, title: "Glass", backdrop_path: null };
    assert.equal(pickMovie([
        { id: 1, title: "Glass Onion", backdrop_path: "/onion.jpg" }, exact,
    ], "Glass"), exact);
});

test("matches TV names and ignores people in TMDB multi-search results", () => {
    const show = { id: 3476, media_type: "tv", name: "Inspector Morse",
        backdrop_path: "/morse.jpg" };
    assert.equal(pickMedia([
        { id: 1, media_type: "person", name: "Inspector Morse" },
        { id: 2, media_type: "movie", title: "Inspector Morse's Oxford" },
        show,
    ], "Inspector Morse"), show);
});

test("selects one exact composer person and rejects ambiguous or partial names", () => {
    const hans = { id: 947, name: "Hans Zimmer", known_for_department: "Sound" };
    assert.equal(pickExactPerson([hans], "Hans Zimmer"), hans);
    assert.equal(pickExactPerson([hans], "Hans Zimmer Live"), null);
    assert.equal(pickExactPerson([hans, { id: 2, name: "Hans Zimmer" }], "Hans Zimmer"), null);
    assert.equal(pickExactPerson([{ id: 0, name: "Hans Zimmer" }], "Hans Zimmer"), null);
});

test("matches a unique whole-title composer crew credit inside an album title", () => {
    const dune = {
        id: 438631, media_type: "movie", title: "Dune", job: "Original Music Composer",
        backdrop_path: "/dune.jpg",
    };
    assert.equal(pickComposerCredit({
        cast: [{ ...dune, job: undefined }],
        crew: [dune, { ...dune }],
    }, "The Dune Sketchbook"), dune);
});

test("rejects unsafe composer-credit fallbacks", () => {
    const credit = (id, title, job = "Original Music Composer") => ({
        id, media_type: "movie", title, job, backdrop_path: "/" + id + ".jpg",
    });
    assert.equal(pickComposerCredit({ crew: [credit(1, "Dune", "Music Supervisor")] },
        "The Dune Sketchbook"), null);
    assert.equal(pickComposerCredit({ crew: [credit(1, "Dune")] },
        "The Dunedin Sketchbook"), null);
    assert.equal(pickComposerCredit({ crew: [credit(1, "Dune"), credit(2, "Sketchbook")] },
        "The Dune Sketchbook"), null);
    assert.equal(pickComposerCredit({ crew: [credit(1, "Up")] },
        "The Up Sketchbook"), null);
    assert.equal(pickComposerCredit({ cast: [credit(1, "Dune")] },
        "The Dune Sketchbook"), null);
});

test("ports the native overlay tint normalization", () => {
    assert.deepEqual(tintFromMeans([20, 40, 80]), [131, 172, 255]);
    assert.deepEqual(tintFromMeans([1, 2, 3]), [255, 255, 255]);
});

test("uses tiny provider-specific tint images", () => {
    assert.equal(tintPreviewUrl("tmdb", "https://image.tmdb.org/t/p/w1280/a.jpg", "/a.jpg"),
        "https://image.tmdb.org/t/p/w92/a.jpg");
    assert.equal(tintPreviewUrl("fanart",
        "https://assets.fanart.tv/fanart/movies/1/a.jpg"),
        "https://assets.fanart.tv/preview/movies/1/a.jpg");
});

test("accepts only explicit backdrop orientations", () => {
    assert.equal(requestedOrientation(undefined), "landscape");
    assert.equal(requestedOrientation("portrait"), "portrait");
    assert.throws(() => requestedOrientation("square"), (error) =>
        error && error.code === "invalid_orientation" && error.status === 400);
});

test("accepts only static SteamGridDB hero and grid CDN URLs", () => {
    assert.equal(trustedSteamGridDbUrl(
        "https://cdn2.steamgriddb.com/hero/abc123.jpg", "hero"),
    "https://cdn2.steamgriddb.com/hero/abc123.jpg");
    assert.equal(trustedSteamGridDbUrl(
        "https://cdn2.steamgriddb.com/hero_thumb/abc123.webp", "thumb"),
    "https://cdn2.steamgriddb.com/hero_thumb/abc123.webp");
    assert.equal(trustedSteamGridDbUrl(
        "https://cdn2.steamgriddb.com/grid/abc123.png", "grid"),
    "https://cdn2.steamgriddb.com/grid/abc123.png");
    assert.equal(trustedSteamGridDbUrl(
        "https://cdn2.steamgriddb.com/thumb/abc123.jpg", "thumb"),
    "https://cdn2.steamgriddb.com/thumb/abc123.jpg");
    assert.equal(trustedSteamGridDbUrl("https://evil.example/hero/abc.jpg", "hero"), "");
    assert.equal(trustedSteamGridDbUrl("https://cdn2.steamgriddb.com/hero/abc.gif", "hero"), "");
    assert.equal(trustedSteamGridDbUrl(
        "https://cdn2.steamgriddb.com/hero/abc.jpg", "grid"), "");
});

test("resolves an explicitly marked game through SteamGridDB hero art", async () => {
    const requests = [];
    let tintUrl = "";
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-key", STEAMGRIDDB_API_KEY: "sgdb-key" },
        fetchImpl: async (url, init) => {
            const value = String(url);
            requests.push(value);
            assert.equal(init.headers.Authorization, "Bearer sgdb-key");
            if (value.includes("/search/autocomplete/Hades")) return response(200, {
                success: true,
                data: [{ id: 5253, name: "Hades", verified: true, release_date: 1600905600 }],
            });
            if (value.includes("/heroes/game/5253")) return response(200, {
                success: true,
                data: [{
                    score: 10, upvotes: 20, width: 3840,
                    url: "https://cdn2.steamgriddb.com/hero/hades.jpg",
                    thumb: "https://cdn2.steamgriddb.com/hero_thumb/hades.jpg",
                }],
            });
            throw new Error("unexpected request " + value);
        },
        tintForImage: async (url) => { tintUrl = url; return [80, 90, 100]; },
    });
    const res = mockResponse();
    await handler(mockRequest({
        title: "Hades (Original Video Game Soundtrack)",
        providers: "fanart,tmdb,steamgriddb",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 5253, title: "Hades", type: "game" },
        backdrop: "https://cdn2.steamgriddb.com/hero/hades.jpg",
        source: "steamgriddb",
        tint: [80, 90, 100],
    });
    assert.equal(requests.length, 2);
    assert.equal(tintUrl, "https://cdn2.steamgriddb.com/hero_thumb/hades.jpg");
});

test("resolves a portrait game request through a SteamGridDB vertical grid", async () => {
    const requests = [];
    let tintUrl = "";
    const handler = createHandler({
        env: { STEAMGRIDDB_API_KEY: "sgdb-key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            requests.push(parsed);
            if (parsed.pathname.endsWith("/search/autocomplete/Hades")) {
                return response(200, { success: true,
                    data: [{ id: 5253, name: "Hades", verified: true }] });
            }
            if (parsed.pathname.endsWith("/grids/game/5253")) return response(200, {
                success: true,
                data: [{
                    score: 10, upvotes: 20, width: 600, height: 900,
                    url: "https://cdn2.steamgriddb.com/grid/hades.png",
                    thumb: "https://cdn2.steamgriddb.com/thumb/hades.jpg",
                }],
            });
            throw new Error("unexpected request " + parsed.href);
        },
        tintForImage: async (url) => { tintUrl = url; return [80, 90, 100]; },
    });
    const res = mockResponse();
    await handler(mockRequest({
        title: "Hades (Original Video Game Soundtrack)",
        providers: "steamgriddb",
        orientation: "portrait",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 5253, title: "Hades", type: "game" },
        backdrop: "https://cdn2.steamgriddb.com/grid/hades.png",
        source: "steamgriddb",
        tint: [80, 90, 100],
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[1].searchParams.get("dimensions"), "600x900,342x482,660x930");
    assert.equal(tintUrl, "https://cdn2.steamgriddb.com/thumb/hades.jpg");
});

test("uses a parenthesized video-game marker before provider order and ratings", async () => {
    const requests = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-key", STEAMGRIDDB_API_KEY: "sgdb-key" },
        fetchImpl: async (url) => {
            const value = String(url);
            requests.push(value);
            if (value.includes("api.themoviedb.org")) {
                throw new Error("explicit video-game metadata must bypass TMDB");
            }
            if (value.includes("/search/autocomplete/Defiance")) return response(200, {
                success: true,
                data: [{ id: 2375, name: "Defiance", verified: true }],
            });
            if (value.includes("/heroes/game/2375")) return response(200, {
                success: true,
                data: [{
                    score: 8, upvotes: 12,
                    url: "https://cdn2.steamgriddb.com/hero/defiance.png",
                    thumb: "https://cdn2.steamgriddb.com/hero_thumb/defiance.png",
                }],
            });
            throw new Error("unexpected request " + value);
        },
        tintForImage: async () => [197, 226, 255],
    });
    const res = mockResponse();
    await handler(mockRequest({
        resolver_version: "16bf184a3c50",
        album: "Defiance+(Video+Game)",
        track: "Dark+Woods",
        artist: "Bear+McCreary",
        providers: "tmdb,steamgriddb,fanart",
        ratings: "DE,US",
    }, {
        // Vercel dev exposes only the pathname here while leaving form-encoded
        // spaces as plus signs in req.query.
        url: "/api/backdrop",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 2375, title: "Defiance", type: "game" },
        backdrop: "https://cdn2.steamgriddb.com/hero/defiance.png",
        source: "steamgriddb",
        tint: [197, 226, 255],
        certifications: [],
    });
    assert.equal(requests.length, 2);
    assert.equal(requests.some((url) => url.includes("api.themoviedb.org")), false);
    assert.match(requests[0], /\/search\/autocomplete\/Defiance$/);
});

test("resolves the abbreviated Superman Returns game marker through SteamGridDB", async () => {
    const requests = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-key", STEAMGRIDDB_API_KEY: "sgdb-key" },
        fetchImpl: async (url) => {
            const value = String(url);
            requests.push(value);
            if (value.includes("api.themoviedb.org")) {
                throw new Error("explicit game metadata must bypass TMDB");
            }
            if (value.includes("/search/autocomplete/Superman%20Returns")) {
                return response(200, { success: true, data: [{
                    id: 38982,
                    name: "Superman Returns",
                    verified: true,
                }] });
            }
            if (value.includes("/heroes/game/38982")) return response(200, {
                success: true,
                data: [{
                    score: 10,
                    url: "https://cdn2.steamgriddb.com/hero/superman-returns.png",
                    thumb: "https://cdn2.steamgriddb.com/hero_thumb/superman-returns.png",
                }],
            });
            throw new Error("unexpected request " + value);
        },
        tintForImage: async () => [212, 234, 255],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Superman Returns (Game)",
        track: "It's A Bird",
        artist: "Colin O'Malley",
        providers: "fanart,tmdb,steamgriddb",
        ratings: "DE,US",
    }), res);

    assert.equal(cleanMovieTitle("Superman Returns (Game)"), "Superman Returns");
    assert.equal(mediaHintForAlbum("Superman Returns (Game)"), "game");
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 38982, title: "Superman Returns", type: "game" },
        backdrop: "https://cdn2.steamgriddb.com/hero/superman-returns.png",
        source: "steamgriddb",
        tint: [212, 234, 255],
        certifications: [],
    });
    assert.equal(requests.length, 2);
});

test("rotates the Skyrim article before resolving its subtitle as a game", async () => {
    const requests = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-key", STEAMGRIDDB_API_KEY: "sgdb-key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            requests.push(parsed.href);
            if (parsed.hostname === "api.themoviedb.org") {
                return response(200, { results: [] });
            }
            if (parsed.pathname === "/api/v2/search/autocomplete/The%20Elder%20Scrolls%20V%3A%20Skyrim") {
                return response(200, { success: true, data: [{
                    id: 22493,
                    name: "The Elder Scrolls V: Skyrim",
                    verified: true,
                }] });
            }
            if (parsed.pathname === "/api/v2/heroes/game/22493") return response(200, {
                success: true,
                data: [{
                    score: 10,
                    url: "https://cdn2.steamgriddb.com/hero/skyrim.png",
                    thumb: "https://cdn2.steamgriddb.com/hero_thumb/skyrim.png",
                }],
            });
            throw new Error("unexpected request " + parsed.href);
        },
        tintForImage: async () => [234, 249, 255],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Elder Scrolls V, The: Skyrim",
        track: "Wind Guide You",
        artist: "Jeremy Soule",
        providers: "fanart,tmdb,steamgriddb",
        ratings: "DE,US",
    }), res);

    assert.equal(cleanMovieTitle("Elder Scrolls V, The: Skyrim"),
        "The Elder Scrolls V: Skyrim");
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 22493, title: "The Elder Scrolls V: Skyrim", type: "game" },
        backdrop: "https://cdn2.steamgriddb.com/hero/skyrim.png",
        source: "steamgriddb",
        tint: [234, 249, 255],
        certifications: [],
    });
    assert.equal(requests.length, 4);
});

test("resolves the ambiguous Medal Of Honor station album as a game", async () => {
    const requests = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-key", STEAMGRIDDB_API_KEY: "sgdb-key" },
        fetchImpl: async (url) => {
            const value = String(url);
            requests.push(value);
            if (value.includes("api.themoviedb.org/3/search/multi")) return response(200, {
                results: [{ id: 83109, media_type: "tv", name: "Medal of Honor",
                    backdrop_path: "/medal-of-honor-tv.jpg" }],
            });
            if (value.includes("api.themoviedb.org/3/tv/83109/content_ratings")) {
                return response(200, { results: [{ iso_3166_1: "US", rating: "TV-MA" }] });
            }
            if (value.includes("/search/autocomplete/Medal%20Of%20Honor")) {
                return response(200, { success: true,
                    data: [{ id: 12091, name: "Medal of Honor", verified: true }] });
            }
            if (value.includes("/heroes/game/12091")) return response(200, {
                success: true, data: [{ score: 10,
                    url: "https://cdn2.steamgriddb.com/hero/medal-of-honor.jpg",
                    thumb: "https://cdn2.steamgriddb.com/hero_thumb/medal-of-honor.jpg" }],
            });
            throw new Error("unexpected request " + value);
        },
        tintForImage: async () => [251, 245, 255],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Medal Of Honor",
        track: "Attack On Fort Schmerzen",
        providers: "fanart,tmdb,steamgriddb",
        ratings: "DE,US",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 12091, title: "Medal of Honor", type: "game" },
        backdrop: "https://cdn2.steamgriddb.com/hero/medal-of-honor.jpg",
        source: "steamgriddb",
        tint: [251, 245, 255],
        certifications: [],
    });
    assert.equal(requests.some((url) => url.includes("api.themoviedb.org")), false);
});

test("resolves Inon Zur's Crysis soundtrack as the game", async () => {
    const requests = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-key", STEAMGRIDDB_API_KEY: "sgdb-key" },
        fetchImpl: async (url) => {
            const value = String(url);
            requests.push(value);
            if (value.includes("/search/autocomplete/Crysis")) return response(200, {
                success: true, data: [{ id: 1548, name: "Crysis", verified: true }],
            });
            if (value.includes("/heroes/game/1548")) return response(200, {
                success: true, data: [{ score: 9,
                    url: "https://cdn2.steamgriddb.com/hero/crysis.png",
                    thumb: "https://cdn2.steamgriddb.com/hero_thumb/crysis.png" }],
            });
            throw new Error("unexpected request " + value);
        },
        tintForImage: async () => [244, 255, 240],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Crysis",
        track: "Guardians",
        artist: "Inon Zur",
        providers: "fanart,tmdb,steamgriddb",
        ratings: "DE,US",
    }), res);

    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 1548, title: "Crysis", type: "game" },
        backdrop: "https://cdn2.steamgriddb.com/hero/crysis.png",
        source: "steamgriddb",
        tint: [244, 255, 240],
        certifications: [],
    });
    assert.equal(requests.some((url) => url.includes("api.themoviedb.org")), false);
});

test("resolves the Enderal soundtrack to Enderal: Forgotten Stories", async () => {
    const requests = [];
    const handler = createHandler({
        env: { STEAMGRIDDB_API_KEY: "sgdb-key" },
        fetchImpl: async (url) => {
            const value = String(url);
            requests.push(value);
            if (value.includes("/search/autocomplete/Enderal%3A%20Forgotten%20Stories")) {
                return response(200, { success: true, data: [{
                    id: 31128,
                    name: "Enderal: Forgotten Stories",
                    verified: true,
                }] });
            }
            if (value.includes("/heroes/game/31128")) return response(200, {
                success: true,
                data: [{
                    score: 10,
                    url: "https://cdn2.steamgriddb.com/hero/enderal.png",
                    thumb: "https://cdn2.steamgriddb.com/hero_thumb/enderal.png",
                }],
            });
            throw new Error("unexpected request " + value);
        },
        tintForImage: async () => [255, 219, 181],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Enderal",
        track: "Two Souls - Zwei Seelen",
        artist: "Marvin Kopp",
        providers: "fanart,tmdb,steamgriddb",
        ratings: "US",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 31128, title: "Enderal: Forgotten Stories", type: "game" },
        backdrop: "https://cdn2.steamgriddb.com/hero/enderal.png",
        source: "steamgriddb",
        tint: [255, 219, 181],
        certifications: [],
    });
    assert.equal(requests.length, 2);
    assert.equal(requests.some((url) => url.includes("api.themoviedb.org")), false);
});

test("resolves the Enola Gay score to the 1980 television film", async () => {
    const requests = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            requests.push(parsed.href);
            if (parsed.pathname === "/3/search/multi") {
                assert.equal(parsed.searchParams.get("query"),
                    "Enola Gay: The Men, the Mission, the Atomic Bomb");
                return response(200, { results: [{
                    id: 170881,
                    media_type: "movie",
                    title: "Enola Gay: The Men, the Mission, the Atomic Bomb",
                    backdrop_path: "/enola-gay.jpg",
                }] });
            }
            if (parsed.pathname === "/3/movie/170881/release_dates") {
                return response(200, { results: [] });
            }
            throw new Error("unexpected request " + parsed.href);
        },
        tintForImage: async () => [255, 246, 245],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Enola Gay",
        track: "Glenn Miller Suite (B) Moonlight Serenade",
        artist: "Maurice Jarre",
        providers: "fanart,tmdb,steamgriddb",
        ratings: "US",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: {
            id: 170881,
            title: "Enola Gay: The Men, the Mission, the Atomic Bomb",
            type: "movie",
        },
        backdrop: "https://image.tmdb.org/t/p/w1280/enola-gay.jpg",
        source: "tmdb",
        tint: [255, 246, 245],
        certifications: [],
    });
    assert.equal(requests.length, 2);
});

test("resolves the Rambo: First Blood album to the first film", async () => {
    const requests = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-key", FANART_API_KEY: "fanart-key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            requests.push(parsed.href);
            if (parsed.pathname === "/3/search/multi") {
                assert.equal(parsed.searchParams.get("query"), "First Blood");
                return response(200, { results: [{
                    id: 1368,
                    media_type: "movie",
                    title: "First Blood",
                    backdrop_path: "/first-blood.jpg",
                }] });
            }
            if (parsed.pathname === "/3/movie/1368/release_dates") {
                return response(200, { results: [] });
            }
            if (parsed.pathname === "/v3/movies/1368") {
                return response(200, { moviebackground: [{
                    url: "https://assets.fanart.tv/fanart/first-blood.jpg",
                    lang: "",
                    likes: "10",
                }] });
            }
            throw new Error("unexpected request " + parsed.href);
        },
        tintForImage: async () => [255, 222, 220],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Rambo: First Blood",
        track: "It's A Long Road (Theme From First Blood)",
        artist: "Dan Hill",
        providers: "fanart,tmdb,steamgriddb",
        ratings: "US",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 1368, title: "First Blood", type: "movie" },
        backdrop: "https://assets.fanart.tv/fanart/first-blood.jpg",
        source: "fanart",
        tint: [255, 222, 220],
        certifications: [],
    });
    assert.equal(requests.length, 3);
});

test("resolves Friday The 13th Part 1 to the 1980 film", async () => {
    const requests = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-key", FANART_API_KEY: "fanart-key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            requests.push(parsed.href);
            if (parsed.pathname === "/3/search/movie") {
                assert.equal(parsed.searchParams.get("query"), "Friday the 13th");
                assert.equal(parsed.searchParams.get("primary_release_year"), "1980");
                return response(200, { results: [{
                    id: 4488,
                    title: "Friday the 13th",
                    backdrop_path: "/friday-the-13th.jpg",
                }] });
            }
            if (parsed.pathname === "/3/search/tv") {
                assert.equal(parsed.searchParams.get("query"), "Friday the 13th");
                assert.equal(parsed.searchParams.get("first_air_date_year"), "1980");
                return response(200, { results: [] });
            }
            if (parsed.pathname === "/3/movie/4488/release_dates") {
                return response(200, { results: [] });
            }
            if (parsed.pathname === "/v3/movies/4488") {
                return response(200, { moviebackground: [{
                    url: "https://assets.fanart.tv/fanart/friday-the-13th.jpg",
                    lang: "",
                    likes: "10",
                }] });
            }
            throw new Error("unexpected request " + parsed.href);
        },
        tintForImage: async () => [249, 252, 255],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Friday The 13th Part 1",
        track: "Sail Away Tiny Sparrow",
        artist: "Harry Manfredini",
        providers: "fanart,tmdb,steamgriddb",
        ratings: "DE,US",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 4488, title: "Friday the 13th", type: "movie" },
        backdrop: "https://assets.fanart.tv/fanart/friday-the-13th.jpg",
        source: "fanart",
        tint: [249, 252, 255],
        certifications: [],
    });
    assert.equal(requests.length, 4);
});

test("resolves M83's Oblivion album to the 2013 film", async () => {
    const requests = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-key", FANART_API_KEY: "fanart-key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            requests.push(parsed.href);
            if (parsed.pathname === "/3/search/movie") {
                assert.equal(parsed.searchParams.get("query"), "Oblivion");
                assert.equal(parsed.searchParams.get("primary_release_year"), "2013");
                return response(200, { results: [{
                    id: 75612,
                    title: "Oblivion",
                    backdrop_path: "/oblivion.jpg",
                }] });
            }
            if (parsed.pathname === "/3/search/tv") {
                assert.equal(parsed.searchParams.get("query"), "Oblivion");
                assert.equal(parsed.searchParams.get("first_air_date_year"), "2013");
                return response(200, { results: [] });
            }
            if (parsed.pathname === "/3/movie/75612/release_dates") {
                return response(200, { results: [] });
            }
            if (parsed.pathname === "/v3/movies/75612") {
                return response(200, { moviebackground: [{
                    url: "https://assets.fanart.tv/fanart/oblivion.jpg",
                    lang: "",
                    likes: "10",
                }] });
            }
            throw new Error("unexpected request " + parsed.href);
        },
        tintForImage: async () => [255, 248, 235],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Oblivion",
        track: "Fearful Odds",
        artist: "m83",
        providers: "fanart,tmdb,steamgriddb",
        ratings: "DE,US",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 75612, title: "Oblivion", type: "movie" },
        backdrop: "https://assets.fanart.tv/fanart/oblivion.jpg",
        source: "fanart",
        tint: [255, 248, 235],
        certifications: [],
    });
    assert.equal(requests.length, 4);
});

test("resolves Mark Kilian's Dolores album to the 2017 documentary", async () => {
    const requests = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-key", FANART_API_KEY: "fanart-key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            requests.push(parsed.href);
            if (parsed.pathname === "/3/search/movie") {
                assert.equal(parsed.searchParams.get("query"), "Dolores");
                assert.equal(parsed.searchParams.get("primary_release_year"), "2017");
                return response(200, { results: [{
                    id: 432619,
                    title: "Dolores",
                    backdrop_path: "/dolores.jpg",
                }] });
            }
            if (parsed.pathname === "/3/search/tv") {
                assert.equal(parsed.searchParams.get("query"), "Dolores");
                assert.equal(parsed.searchParams.get("first_air_date_year"), "2017");
                return response(200, { results: [] });
            }
            if (parsed.pathname === "/3/movie/432619/release_dates") {
                return response(200, { results: [] });
            }
            if (parsed.pathname === "/v3/movies/432619") return response(200, {});
            throw new Error("unexpected request " + parsed.href);
        },
        tintForImage: async () => [225, 235, 245],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Dolores",
        track: "Fred Ross",
        artist: "Mark Kilian",
        providers: "fanart,tmdb,steamgriddb",
        ratings: "DE,US",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 432619, title: "Dolores", type: "movie" },
        backdrop: "https://image.tmdb.org/t/p/w1280/dolores.jpg",
        source: "tmdb",
        tint: [225, 235, 245],
        certifications: [],
    });
    assert.equal(requests.length, 4);
});

test("does not force different Medal Of Honor track metadata to the game", async () => {
    const requests = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-key", STEAMGRIDDB_API_KEY: "sgdb-key" },
        fetchImpl: async (url) => {
            const value = String(url);
            requests.push(value);
            if (value.includes("api.themoviedb.org/3/search/multi")) return response(200, {
                results: [{ id: 83109, media_type: "tv", name: "Medal of Honor",
                    backdrop_path: "/medal-of-honor-tv.jpg" }],
            });
            throw new Error("unexpected request " + value);
        },
        tintForImage: async () => [220, 230, 240],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Medal Of Honor",
        track: "A Different Cue",
        providers: "fanart,tmdb,steamgriddb",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 83109, title: "Medal of Honor", type: "tv" },
        backdrop: "https://image.tmdb.org/t/p/w1280/medal-of-honor-tv.jpg",
        source: "tmdb",
        tint: [220, 230, 240],
    });
    assert.equal(requests.some((url) => url.includes("steamgriddb.com")), false);
});

test("does not resolve Thomas Bergersen's standalone Illusions album as a movie", async () => {
    const requests = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-key", STEAMGRIDDB_API_KEY: "sgdb-key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            requests.push(parsed.href);
            if (parsed.pathname === "/3/search/multi") return response(200, { results: [{
                id: 161785, media_type: "movie", title: "Illusions",
                backdrop_path: "/illusions-movie.jpg",
            }] });
            if (parsed.pathname === "/3/search/person") {
                const name = parsed.searchParams.get("query");
                return response(200, { results: [{
                    id: name === "Thomas Bergersen" ? 2458162 : 999,
                    name,
                    known_for_department: name === "Thomas Bergersen" ? "Sound" : "Acting",
                }] });
            }
            if (parsed.pathname === "/3/movie/161785/credits") return response(200, {
                crew: [{ id: 34734, name: "Robert J. Walsh",
                    department: "Sound", job: "Original Music Composer" }],
            });
            if (parsed.hostname === "www.steamgriddb.com") {
                return response(200, { success: true, data: [] });
            }
            throw new Error("unexpected request " + parsed.href);
        },
        tintForImage: async () => [255, 239, 236],
    });

    const standaloneRes = mockResponse();
    await handler(mockRequest({
        album: "Illusions",
        track: "Aura",
        artist: "Thomas Bergersen",
        providers: "fanart,tmdb,steamgriddb",
        ratings: "DE,US",
    }), standaloneRes);
    assert.equal(standaloneRes.statusCode, 200);
    assert.deepEqual(JSON.parse(standaloneRes.body), {
        media: null,
        backdrop: null,
        source: null,
        tint: [255, 255, 255],
        certifications: [],
    });
    assert.equal(requests.some((url) => url.includes("/3/movie/161785/credits")), true);

    const movieRes = mockResponse();
    await handler(mockRequest({
        album: "Illusions",
        track: "Main Title",
        artist: "A Different Composer",
        providers: "tmdb",
    }), movieRes);
    assert.equal(JSON.parse(movieRes.body).media.type, "movie");
    assert.equal(requests.some((url) => url.includes("/3/search/multi")), true);
    assert.equal(requests.filter((url) => url.includes("/3/movie/161785/credits")).length, 1);
});

test("keeps exact movies when composer validation is positive or inconclusive", async () => {
    const scenarios = [
        { name: "matching composer", credits: response(200, { crew: [{
            id: 19099, job: "Original Music Composer",
        }] }) },
        { name: "empty credits", credits: response(200, { crew: [] }) },
        { name: "unavailable credits", credits: response(503, {}) },
    ];

    for (const scenario of scenarios) {
        const handler = createHandler({
            env: { TMDB_API_KEY: "tmdb-key" },
            fetchImpl: async (url) => {
                const parsed = new URL(url);
                if (parsed.pathname === "/3/search/multi") return response(200, { results: [{
                    id: 329865, media_type: "movie", title: "Arrival",
                    backdrop_path: "/arrival.jpg",
                }] });
                if (parsed.pathname === "/3/search/person") return response(200, { results: [{
                    id: 19099, name: "Jóhann Jóhannsson", known_for_department: "Sound",
                }] });
                if (parsed.pathname === "/3/movie/329865/credits") return scenario.credits;
                throw new Error("unexpected request " + parsed.href);
            },
            tintForImage: async () => [100, 110, 120],
        });
        const res = mockResponse();
        await handler(mockRequest({
            album: "Arrival",
            track: "Heptapod B",
            artist: "Jóhann Jóhannsson",
            providers: "tmdb",
        }), res);

        assert.equal(res.statusCode, 200, scenario.name);
        assert.deepEqual(JSON.parse(res.body), {
            media: { id: 329865, title: "Arrival", type: "movie" },
            backdrop: "https://image.tmdb.org/t/p/w1280/arrival.jpg",
            source: "tmdb",
            tint: [100, 110, 120],
        }, scenario.name);
    }
});

test("uses an exact base-game hero when an exact expansion has no hero", async () => {
    const requests = [];
    const handler = createHandler({
        env: { STEAMGRIDDB_API_KEY: "sgdb-key" },
        fetchImpl: async (url) => {
            const value = String(url);
            requests.push(value);
            if (value.includes("/search/autocomplete/Starcraft%20II%3A%20Heart%20Of%20The%20Swarm")) {
                return response(200, { success: true, data: [{
                    id: 5256005, name: "StarCraft II: Heart of the Swarm", verified: true,
                }] });
            }
            if (value.includes("/heroes/game/5256005")) {
                return response(200, { success: true, data: [] });
            }
            if (value.includes("/search/autocomplete/Starcraft%20II")) {
                return response(200, { success: true, data: [{
                    id: 34795, name: "StarCraft II", verified: true,
                }] });
            }
            if (value.includes("/heroes/game/34795")) return response(200, {
                success: true,
                data: [{
                    url: "https://cdn2.steamgriddb.com/hero/starcraft-ii.jpg",
                    thumb: "https://cdn2.steamgriddb.com/hero_thumb/starcraft-ii.jpg",
                }],
            });
            throw new Error("unexpected request " + value);
        },
        tintForImage: async () => [20, 30, 40],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Starcraft II: Heart Of The Swarm",
        track: "The Coming Storm",
        artist: "Glenn Stafford, Neal Acree, Derek Duke",
        providers: "fanart,tmdb,steamgriddb",
        ratings: "DE,US",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 5256005, title: "StarCraft II: Heart of the Swarm", type: "game" },
        backdrop: "https://cdn2.steamgriddb.com/hero/starcraft-ii.jpg",
        source: "steamgriddb",
        tint: [20, 30, 40],
        certifications: [],
    });
    assert.equal(requests.length, 4);
});

test("resolves a Stellaris species pack through its exact base game", async () => {
    const requests = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-key", STEAMGRIDDB_API_KEY: "sgdb-key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            requests.push(parsed.href);
            if (parsed.pathname === "/3/search/person") return response(200, { results: [] });
            if (parsed.pathname === "/3/search/multi") return response(200, { results: [] });
            if (parsed.pathname === "/api/v2/search/autocomplete/Stellaris%3A%20Humanoids%20Species%20Pack") {
                return response(200, { success: true, data: [
                    { id: 3924, name: "Stellaris", verified: true },
                    { id: 5353607, name: "Stellaris ST: New Horizons", verified: true },
                ] });
            }
            if (parsed.pathname === "/api/v2/heroes/game/3924") return response(200, {
                success: true,
                data: [{
                    score: 10,
                    url: "https://cdn2.steamgriddb.com/hero/stellaris.png",
                    thumb: "https://cdn2.steamgriddb.com/hero_thumb/stellaris.png",
                }],
            });
            throw new Error("unexpected request " + parsed.href);
        },
        tintForImage: async () => [190, 224, 255],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Stellaris: Humanoids Species Pack",
        track: "Towards Utopia Nova Flare",
        artist: "Meyer",
        providers: "fanart,tmdb,steamgriddb",
        ratings: "DE,US",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 3924, title: "Stellaris", type: "game" },
        backdrop: "https://cdn2.steamgriddb.com/hero/stellaris.png",
        source: "steamgriddb",
        tint: [190, 224, 255],
        certifications: [],
    });
    assert.equal(requests.length, 4);
});

test("resolves the Stellaris Utopia soundtrack through its base game", async () => {
    const requests = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-key", STEAMGRIDDB_API_KEY: "sgdb-key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            requests.push(parsed.href);
            if (parsed.pathname === "/api/v2/search/autocomplete/Stellaris") {
                return response(200, { success: true, data: [
                    { id: 3924, name: "Stellaris", verified: true },
                    { id: 5353607, name: "Stellaris ST: New Horizons", verified: true },
                ] });
            }
            if (parsed.pathname === "/api/v2/heroes/game/3924") return response(200, {
                success: true,
                data: [{
                    score: 10,
                    url: "https://cdn2.steamgriddb.com/hero/stellaris-utopia.png",
                    thumb: "https://cdn2.steamgriddb.com/hero_thumb/stellaris-utopia.png",
                }],
            });
            throw new Error("unexpected request " + parsed.href);
        },
        tintForImage: async () => [100, 120, 160],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Stellaris: Utopia",
        track: "Utopia Main Title",
        artist: "Andreas Waldetoft",
        providers: "fanart,tmdb,tvmaze,steamgriddb",
        ratings: "DE,US",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 3924, title: "Stellaris", type: "game" },
        backdrop: "https://cdn2.steamgriddb.com/hero/stellaris-utopia.png",
        source: "steamgriddb",
        tint: [100, 120, 160],
        certifications: [],
    });
    assert.equal(requests.length, 2);
});

test("resolves a Video Games Live suite through its game track", async () => {
    const requests = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-key", STEAMGRIDDB_API_KEY: "sgdb-key" },
        fetchImpl: async (url) => {
            const value = String(url);
            requests.push(value);
            if (value.includes("/search/autocomplete/The%20Legend%20Of%20Zelda")) {
                return response(200, { success: true, data: [{
                    id: 38050, name: "The Legend of Zelda", verified: true,
                }] });
            }
            if (value.includes("/heroes/game/38050")) return response(200, {
                success: true,
                data: [{ score: 10,
                    url: "https://cdn2.steamgriddb.com/hero/zelda.jpg",
                    thumb: "https://cdn2.steamgriddb.com/hero_thumb/zelda.jpg" }],
            });
            throw new Error("unexpected request " + value);
        },
        tintForImage: async () => [10, 20, 30],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Video Games Live: Level 2",
        track: "The Legend Of Zelda Suite",
        providers: "fanart,tmdb,steamgriddb",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 38050, title: "The Legend of Zelda", type: "game" },
        backdrop: "https://cdn2.steamgriddb.com/hero/zelda.jpg",
        source: "steamgriddb",
        tint: [10, 20, 30],
    });
    assert.equal(requests.length, 2);
    assert.equal(requests.some((url) => url.includes("api.themoviedb.org")), false);
});

test("resolves a shortened Video Games Live game title", async () => {
    const requests = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-key", STEAMGRIDDB_API_KEY: "sgdb-key" },
        fetchImpl: async (url) => {
            const value = String(url);
            requests.push(value);
            if (value.includes("/search/autocomplete/Phoenix%20Wright")) {
                return response(200, { success: true, data: [{
                    id: 34587,
                    name: "Phoenix Wright: Ace Attorney - Justice For All",
                    verified: true,
                }, {
                    id: 38330, name: "Phoenix Wright: Ace Attorney", verified: true,
                }] });
            }
            if (value.includes("/heroes/game/38330")) return response(200, {
                success: true,
                data: [{ score: 10,
                    url: "https://cdn2.steamgriddb.com/hero/phoenix-wright.png",
                    thumb: "https://cdn2.steamgriddb.com/hero_thumb/phoenix-wright.png" }],
            });
            throw new Error("unexpected request " + value);
        },
        tintForImage: async () => [30, 40, 50],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Video Games Live: Level 5",
        track: "Phoenix Wright",
        providers: "tmdb,steamgriddb,fanart",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 38330, title: "Phoenix Wright: Ace Attorney", type: "game" },
        backdrop: "https://cdn2.steamgriddb.com/hero/phoenix-wright.png",
        source: "steamgriddb",
        tint: [30, 40, 50],
    });
    assert.equal(requests.length, 2);
    assert.equal(requests.some((url) => url.includes("api.themoviedb.org")), false);
});

test("resolves Conker through its SteamGridDB ampersand spelling", async () => {
    const handler = createHandler({
        env: { STEAMGRIDDB_API_KEY: "sgdb-key" },
        fetchImpl: async (url) => {
            const value = String(url);
            if (value.includes("/search/autocomplete/Conker%3A%20Live%20And%20Reloaded")) {
                return response(200, { success: true, data: [{
                    id: 5256835, name: "Conker: Live & Reloaded", verified: true,
                }] });
            }
            if (value.includes("/heroes/game/5256835")) return response(200, {
                success: true,
                data: [{ score: 10,
                    url: "https://cdn2.steamgriddb.com/hero/conker.jpg",
                    thumb: "https://cdn2.steamgriddb.com/hero_thumb/conker.jpg" }],
            });
            throw new Error("unexpected request " + value);
        },
        tintForImage: async () => [45, 55, 65],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Conker: Live And Reloaded",
        track: "Surf Punks (Original Version)",
        providers: "steamgriddb",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 5256835, title: "Conker: Live & Reloaded", type: "game" },
        backdrop: "https://cdn2.steamgriddb.com/hero/conker.jpg",
        source: "steamgriddb",
        tint: [45, 55, 65],
    });
});

test("resolves a Great British TV Themes cue through an exact track prefix", async () => {
    const queries = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            const query = parsed.searchParams.get("query");
            queries.push(query);
            return response(200, { results: [{
                id: 4354, media_type: "tv", name: "The Protectors",
                backdrop_path: "/protectors.jpg",
            }] });
        },
        tintForImage: async () => [40, 50, 60],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Great British TV Themes",
        track: "The Protectors Avenues And Alleyways",
        providers: "tmdb",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(queries, [
        "The Protectors Avenues And Alleyways",
        "The Protectors Avenues And",
        "The Protectors Avenues",
        "The Protectors",
    ]);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 4354, title: "The Protectors", type: "tv" },
        backdrop: "https://image.tmdb.org/t/p/w1280/protectors.jpg",
        source: "tmdb",
        tint: [40, 50, 60],
    });
});

test("resolves an explicit TV-series theme from a mixed compilation", async () => {
    const requests = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-key", FANART_API_KEY: "fanart-key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            requests.push(parsed.pathname);
            if (parsed.pathname === "/3/search/person") return response(200, { results: [] });
            if (parsed.pathname === "/3/search/multi") {
                assert.equal(parsed.searchParams.get("query"), "Wonder Woman");
                return response(200, { results: [
                    { id: 297762, media_type: "movie", title: "Wonder Woman",
                        backdrop_path: "/wonder-woman-movie.jpg" },
                    { id: 4331, media_type: "tv", name: "Wonder Woman",
                        backdrop_path: "/wonder-woman-tv.jpg" },
                ] });
            }
            if (parsed.pathname === "/3/tv/4331/content_ratings") {
                return response(200, { results: [] });
            }
            if (parsed.pathname === "/3/tv/4331/external_ids") {
                return response(200, { tvdb_id: null });
            }
            throw new Error("unexpected request " + parsed.href);
        },
        tintForImage: async () => [255, 153, 147],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Music Of DC Comics, The: Volume 2",
        track: "Wonder Woman Tv Series Season 3 Theme (1978)",
        artist: "Charles Fox And Norman Gimble",
        providers: "fanart,tmdb,steamgriddb",
        ratings: "DE,US",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 4331, title: "Wonder Woman", type: "tv" },
        backdrop: "https://image.tmdb.org/t/p/w1280/wonder-woman-tv.jpg",
        source: "tmdb",
        tint: [255, 153, 147],
        certifications: [],
    });
    assert.deepEqual(requests.sort(), [
        "/3/search/multi",
        "/3/search/person",
        "/3/tv/4331/content_ratings",
        "/3/tv/4331/external_ids",
    ]);
});

test("resolves a Television's Greatest Hits track as TV", async () => {
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            assert.equal(parsed.pathname, "/3/search/multi");
            assert.equal(parsed.searchParams.get("query"), "Surfside 6");
            return response(200, { results: [{
                id: 2627, media_type: "tv", name: "Surfside 6",
                backdrop_path: "/surfside-6.jpg",
            }] });
        },
        tintForImage: async () => [60, 90, 120],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Television's Greatest Hits 1, From The 50's And 60's",
        track: "Surfside 6",
        providers: "tmdb",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 2627, title: "Surfside 6", type: "tv" },
        backdrop: "https://image.tmdb.org/t/p/w1280/surfside-6.jpg",
        source: "tmdb",
        tint: [60, 90, 120],
    });
});

test("bounds TV compilation prefix searches", () => {
    const candidates = backdropTitleCandidatesFor("Great British TV Themes",
        "One Two Three Four Five Six Seven Eight Nine Ten Eleven Twelve");
    assert.equal(candidates.length, 8);
});

test("rejects fuzzy TV-prefix results for a Great British TV Themes track", async () => {
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-key" },
        fetchImpl: async () => response(200, { results: [{
            id: 999, media_type: "tv", name: "Unrelated Programme",
            backdrop_path: "/unrelated.jpg",
        }] }),
        tintForImage: async () => { throw new Error("must not resolve tint"); },
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Great British TV Themes",
        track: "Unknown Programme Famous Theme",
        providers: "tmdb",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: null,
        backdrop: null,
        source: null,
        tint: [255, 255, 255],
    });
});

test("uses provider order to break an otherwise ambiguous exact title", async () => {
    let tmdbRequests = 0;
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-key", STEAMGRIDDB_API_KEY: "sgdb-key" },
        fetchImpl: async (url) => {
            const value = String(url);
            if (value.includes("steamgriddb.com/api/v2/search")) return response(200, {
                success: true, data: [{ id: 99, name: "Prey", verified: true }],
            });
            if (value.includes("steamgriddb.com/api/v2/heroes")) return response(200, {
                success: true, data: [{ score: 1,
                    url: "https://cdn2.steamgriddb.com/hero/prey.jpg",
                    thumb: "https://cdn2.steamgriddb.com/hero_thumb/prey.jpg" }],
            });
            tmdbRequests++;
            return response(200, { results: [{ id: 1, media_type: "movie",
                title: "Prey", backdrop_path: "/prey.jpg" }] });
        },
        tintForImage: async () => [1, 2, 3],
    });
    const res = mockResponse();
    await handler(mockRequest({ title: "Prey", providers: "steamgriddb,tmdb" }), res);
    assert.equal(JSON.parse(res.body).media.type, "game");
    assert.equal(tmdbRequests, 0);
});

test("prefers an exact game match over a partial screen-catalog result", async () => {
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-key", STEAMGRIDDB_API_KEY: "sgdb-key" },
        fetchImpl: async (url) => {
            const value = String(url);
            if (value.includes("api.themoviedb.org")) return response(200, { results: [{
                id: 1, media_type: "movie", title: "Journey to Hades", backdrop_path: "/partial.jpg",
            }] });
            if (value.includes("/search/autocomplete/Hades")) return response(200, {
                success: true, data: [{ id: 5253, name: "Hades", verified: true }],
            });
            if (value.includes("/heroes/game/5253")) return response(200, {
                success: true, data: [{ score: 2,
                    url: "https://cdn2.steamgriddb.com/hero/hades.jpg",
                    thumb: "https://cdn2.steamgriddb.com/hero_thumb/hades.jpg" }],
            });
            throw new Error("unexpected request " + value);
        },
        tintForImage: async () => [4, 5, 6],
    });
    const res = mockResponse();
    await handler(mockRequest({
        title: "Hades", providers: "fanart,tmdb,steamgriddb",
    }), res);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 5253, title: "Hades", type: "game" },
        backdrop: "https://cdn2.steamgriddb.com/hero/hades.jpg",
        source: "steamgriddb",
        tint: [4, 5, 6],
    });
});

test("resolves fanart first and returns a precomputed tint", async () => {
    const requests = [];
    const fetchImpl = async (url) => {
        const value = String(url);
        requests.push(value);
        if (value.startsWith("https://api.themoviedb.org/3/search/multi")) {
            return response(200, { results: [{
                id: 429, media_type: "movie", title: "The Good, the Bad and the Ugly",
                backdrop_path: "/tmdb.jpg",
            }] });
        }
        if (value.startsWith("https://webservice.fanart.tv/v3/movies/429")) {
            return response(200, { moviebackground: [{
                url: "https://assets.fanart.tv/fanart/movies/429/best.jpg",
                lang: "", likes: "12",
            }] });
        }
        throw new Error("unexpected request " + value);
    };
    let tintUrl = "";
    const handler = createHandler({
        env: {
            TMDB_API_KEY: "tmdb-project-key",
            FANART_API_KEY: "fanart-project-key",
            BACKDROP_ALLOWED_ORIGINS: "https://example.test",
        },
        fetchImpl,
        tintForImage: async (url) => { tintUrl = url; return [12, 34, 56]; },
    });
    const res = mockResponse();
    await handler(mockRequest({
        title: "The Good, the Bad and the Ugly",
        client_key: "personal-key",
    }, { headers: { origin: "https://example.test" } }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 429, title: "The Good, the Bad and the Ugly", type: "movie" },
        backdrop: "https://assets.fanart.tv/fanart/movies/429/best.jpg",
        source: "fanart",
        tint: [12, 34, 56],
    });
    assert.match(requests[1], /client_key=personal-key/);
    assert.equal(tintUrl, "https://assets.fanart.tv/preview/movies/429/best.jpg");
    assert.equal(res.headers.get("access-control-allow-origin"), "https://example.test");
    assert.equal(res.headers.get("cache-control"), "public, max-age=" + CACHE_SECONDS
        + ", s-maxage=" + CACHE_SECONDS + ", stale-while-revalidate=86400");
});

test("uses a fanart poster only for an explicit portrait request", async () => {
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-key", FANART_API_KEY: "fanart-key" },
        fetchImpl: async (url) => {
            const value = String(url);
            if (value.includes("/search/multi")) return response(200, { results: [{
                id: 7, media_type: "movie", title: "Arrival",
                backdrop_path: "/arrival-backdrop.jpg", poster_path: "/arrival-poster.jpg",
            }] });
            if (value.includes("/v3/movies/7")) return response(200, {
                moviebackground: [{
                    url: "https://assets.fanart.tv/fanart/arrival-backdrop.jpg",
                    lang: "00", likes: "20",
                }],
                movieposter: [{
                    url: "https://assets.fanart.tv/fanart/arrival-poster.jpg",
                    lang: "en", likes: "12",
                }],
            });
            throw new Error("unexpected request " + value);
        },
        tintForImage: async () => [100, 110, 120],
    });
    const res = mockResponse();
    await handler(mockRequest({
        title: "Arrival", providers: "fanart,tmdb", orientation: "portrait",
    }), res);

    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 7, title: "Arrival", type: "movie" },
        backdrop: "https://assets.fanart.tv/fanart/arrival-poster.jpg",
        source: "fanart",
        tint: [100, 110, 120],
    });
});

test("falls back to TMDB when fanart is unavailable", async () => {
    const handler = createHandler({
        env: { TMDB_READ_TOKEN: "read-token", FANART_API_KEY: "fanart-key" },
        fetchImpl: async (url, init) => {
            const value = String(url);
            if (value.includes("search/multi")) {
                assert.equal(init.headers.Authorization, "Bearer read-token");
                return response(200, { results: [{ id: 7, media_type: "movie",
                    title: "Arrival", backdrop_path: "/arrival.jpg" }] });
            }
            return response(500, {});
        },
        tintForImage: async () => [100, 110, 120],
    });
    const res = mockResponse();
    await handler(mockRequest({ title: "Arrival" }), res);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 7, title: "Arrival", type: "movie" },
        backdrop: "https://image.tmdb.org/t/p/w1280/arrival.jpg",
        source: "tmdb",
        tint: [100, 110, 120],
    });
});

test("uses TMDB poster_path for an explicit portrait request", async () => {
    let tintUrl = "";
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async () => response(200, { results: [{
            id: 7, media_type: "movie", title: "Arrival",
            backdrop_path: "/arrival-backdrop.jpg", poster_path: "/arrival-poster.jpg",
        }] }),
        tintForImage: async (url) => { tintUrl = url; return [100, 110, 120]; },
    });
    const res = mockResponse();
    await handler(mockRequest({
        title: "Arrival", providers: "tmdb", orientation: "portrait",
    }), res);

    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 7, title: "Arrival", type: "movie" },
        backdrop: "https://image.tmdb.org/t/p/w780/arrival-poster.jpg",
        source: "tmdb",
        tint: [100, 110, 120],
    });
    assert.equal(tintUrl, "https://image.tmdb.org/t/p/w92/arrival-poster.jpg");
});

test("sends a soundtrack release year as a TMDB filter", async () => {
    const searchUrls = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-project-key" },
        fetchImpl: async (url) => {
            const searchUrl = new URL(url);
            searchUrls.push(searchUrl);
            return response(200, { results: searchUrl.pathname.endsWith("/movie") ? [{
                id: 912, title: "The Thomas Crown Affair", backdrop_path: "/crown.jpg",
            }] : [] });
        },
        tintForImage: async () => [10, 20, 30],
    });
    const res = mockResponse();
    await handler(mockRequest({
        title: "Thomas Crown Affair, The (1968)", providers: "tmdb",
    }), res);

    const movieUrl = searchUrls.find((url) => url.pathname.endsWith("/movie"));
    const tvUrl = searchUrls.find((url) => url.pathname.endsWith("/tv"));
    assert.equal(movieUrl.searchParams.get("query"), "The Thomas Crown Affair");
    assert.equal(movieUrl.searchParams.get("primary_release_year"), "1968");
    assert.equal(tvUrl.searchParams.get("query"), "The Thomas Crown Affair");
    assert.equal(tvUrl.searchParams.get("first_air_date_year"), "1968");
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 912, title: "The Thomas Crown Affair", type: "movie" },
        backdrop: "https://image.tmdb.org/t/p/w1280/crown.jpg",
        source: "tmdb",
        tint: [10, 20, 30],
    });
});

test("resolves TV fanart through the series TheTVDB id", async () => {
    const requests = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-project-key", FANART_API_KEY: "fanart-project-key" },
        fetchImpl: async (url) => {
            const value = String(url);
            requests.push(value);
            if (value.includes("/search/multi")) {
                assert.equal(new URL(value).searchParams.get("query"), "Inspector Morse");
                return response(200, { results: [{
                    id: 3476, media_type: "tv", name: "Inspector Morse",
                    backdrop_path: "/tmdb-morse.jpg",
                }] });
            }
            if (value.includes("/tv/3476/external_ids")) {
                return response(200, { tvdb_id: 76582 });
            }
            if (value.includes("webservice.fanart.tv/v3/tv/76582")) {
                return response(200, { showbackground: [{
                    url: "https://assets.fanart.tv/fanart/tv/76582/showbackground/morse.jpg",
                    lang: "00", likes: "8",
                }] });
            }
            throw new Error("unexpected request " + value);
        },
        tintForImage: async () => [90, 100, 110],
    });
    const res = mockResponse();
    await handler(mockRequest({
        title: "The Magic Of Inspector Morse", providers: "fanart,tmdb",
        client_key: "personal-key",
    }), res);

    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 3476, title: "Inspector Morse", type: "tv" },
        backdrop: "https://assets.fanart.tv/fanart/tv/76582/showbackground/morse.jpg",
        source: "fanart",
        tint: [90, 100, 110],
    });
    assert.match(requests[2], /client_key=personal-key/);
});

test("resolves TVmaze landscape and portrait art through the exact TheTVDB id", async () => {
    const requests = [];
    let tintUrl = "";
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-project-key" },
        fetchImpl: async (url) => {
            const value = String(url);
            requests.push(value);
            if (value.includes("/search/multi")) return response(200, { results: [{
                id: 3476, media_type: "tv", name: "Inspector Morse", backdrop_path: "/tmdb.jpg",
            }] });
            if (value.includes("/tv/3476/external_ids")) return response(200, { tvdb_id: 76582 });
            if (value.startsWith("https://api.tvmaze.com/lookup/shows")) {
                assert.equal(new URL(value).searchParams.get("thetvdb"), "76582");
                return response(200, { id: 3276, name: "Inspector Morse" });
            }
            if (value === "https://api.tvmaze.com/shows/3276/images") return response(200, [
                { type: "poster", main: true, resolutions: { original: {
                    url: "https://static.tvmaze.com/uploads/images/original_untouched/poster.jpg",
                    width: 680, height: 1000,
                } } },
                { type: "background", main: true, resolutions: { original: {
                    url: "https://example.com/untrusted.jpg", width: 3840, height: 2160,
                } } },
                { type: "background", main: false, resolutions: { original: {
                    url: "https://static.tvmaze.com/uploads/images/original_untouched/223/558821.jpg",
                    width: 1920, height: 1080,
                } } },
            ]);
            throw new Error("unexpected request " + value);
        },
        tintForImage: async (url) => { tintUrl = url; return [91, 101, 111]; },
    });
    const res = mockResponse();
    await handler(mockRequest({ title: "Inspector Morse", providers: "tvmaze,tmdb" }), res);

    const backdrop = "https://static.tvmaze.com/uploads/images/original_untouched/223/558821.jpg";
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 3476, title: "Inspector Morse", type: "tv" },
        backdrop,
        source: "tvmaze",
        tint: [91, 101, 111],
    });
    assert.equal(tintUrl, backdrop);
    assert.equal(requests.filter((value) => value.includes("/external_ids")).length, 1);
    assert.equal(trustedTvmazeUrl(backdrop), backdrop);
    assert.equal(trustedTvmazeUrl("https://example.com/background.jpg"), "");

    const portraitRes = mockResponse();
    await handler(mockRequest({
        title: "Inspector Morse", providers: "tvmaze,tmdb", orientation: "portrait",
    }), portraitRes);
    const poster = "https://static.tvmaze.com/uploads/images/original_untouched/poster.jpg";
    assert.deepEqual(JSON.parse(portraitRes.body), {
        media: { id: 3476, title: "Inspector Morse", type: "tv" },
        backdrop: poster,
        source: "tvmaze",
        tint: [91, 101, 111],
    });
    assert.equal(tintUrl, poster);
});

test("falls back to TMDB when TVmaze has no matching show", async () => {
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const value = String(url);
            if (value.includes("/search/multi")) return response(200, { results: [{
                id: 3476, media_type: "tv", name: "Inspector Morse", backdrop_path: "/morse.jpg",
            }] });
            if (value.includes("/tv/3476/external_ids")) return response(200, { tvdb_id: 76582 });
            if (value.startsWith("https://api.tvmaze.com/lookup/shows")) return response(404, {});
            throw new Error("unexpected request " + value);
        },
        tintForImage: async () => [120, 130, 140],
    });
    const res = mockResponse();
    await handler(mockRequest({ title: "Inspector Morse", providers: "tvmaze,tmdb" }), res);

    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 3476, title: "Inspector Morse", type: "tv" },
        backdrop: "https://image.tmdb.org/t/p/w1280/morse.jpg",
        source: "tmdb",
        tint: [120, 130, 140],
    });
});

test("falls back to the TMDB series backdrop when TV fanart is unavailable", async () => {
    const handler = createHandler({
        env: { TMDB_API_KEY: "key", FANART_API_KEY: "fanart-key" },
        fetchImpl: async (url) => {
            const value = String(url);
            if (value.includes("/search/multi")) return response(200, { results: [{
                id: 3476, media_type: "tv", name: "Inspector Morse",
                backdrop_path: "/morse.jpg",
            }] });
            if (value.includes("/tv/3476/external_ids")) return response(200, { tvdb_id: 76582 });
            if (value.includes("webservice.fanart.tv/v3/tv/76582")) return response(200, {});
            throw new Error("unexpected request " + value);
        },
        tintForImage: async () => [120, 130, 140],
    });
    const res = mockResponse();
    await handler(mockRequest({ title: "The Magic Of Inspector Morse" }), res);

    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 3476, title: "Inspector Morse", type: "tv" },
        backdrop: "https://image.tmdb.org/t/p/w1280/morse.jpg",
        source: "tmdb",
        tint: [120, 130, 140],
    });
});

test("auto-detects a v4 read token stored under the legacy TMDB_API_KEY name", async () => {
    const legacyToken = "eyJhbGciOiJIUzI1NiJ9.payload.signature";
    const handler = createHandler({
        env: { TMDB_API_KEY: legacyToken },
        fetchImpl: async (url, init) => {
            assert.equal(init.headers.Authorization, "Bearer " + legacyToken);
            assert.equal(new URL(url).searchParams.has("api_key"), false);
            return response(200, { results: [] });
        },
        tintForImage: async () => { throw new Error("must not run"); },
    });
    const res = mockResponse();
    await handler(mockRequest({ title: "Arrival", providers: "tmdb" }), res);
    assert.equal(res.statusCode, 200);
});

test("returns a cacheable miss without exposing provider details", async () => {
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async () => response(200, { results: [] }),
        tintForImage: async () => { throw new Error("must not run"); },
    });
    const res = mockResponse();
    await handler(mockRequest({ title: "Unknown" }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: null, backdrop: null, source: null, tint: [255, 255, 255],
    });
    assert.equal(res.headers.get("cache-control"), "public, max-age=" + MISS_CACHE_SECONDS
        + ", s-maxage=" + MISS_CACHE_SECONDS + ", stale-while-revalidate=60");
});

test("rejects invalid artist metadata before provider access", async () => {
    let requests = 0;
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async () => {
            requests++;
            return response(200, { results: [] });
        },
        tintForImage: async () => { throw new Error("must not run"); },
    });
    for (const artist of ["x".repeat(181), "Hans\u0000Zimmer"]) {
        const res = mockResponse();
        await handler(mockRequest({ title: "Dune", artist }), res);
        assert.equal(res.statusCode, 400);
        assert.deepEqual(JSON.parse(res.body), { error: "invalid_artist" });
    }
    assert.equal(requests, 0);
});

test("accepts only canonical and 40 px cover URLs from explicitly allowed hosts", () => {
    const env = { TINT_ALLOWED_HOSTS: "streamingsoundtracks.com" };
    assert.equal(trustedCoverTintUrl(
        "https://streamingsoundtracks.com/images/cover/B000FBFTCS.jpg", env),
    "https://streamingsoundtracks.com/images/cover/B000FBFTCS.jpg");
    assert.equal(trustedCoverTintUrl(
        "https://streamingsoundtracks.com/images/cover/040/B000FBFTCS.jpg", env),
    "https://streamingsoundtracks.com/images/cover/040/B000FBFTCS.jpg");
    assert.equal(trustedCoverTintUrl("http://streamingsoundtracks.com/images/cover/a.jpg", env), "");
    assert.equal(trustedCoverTintUrl("https://evil.example/images/cover/a.jpg", env), "");
    assert.equal(trustedCoverTintUrl("https://streamingsoundtracks.com/admin", env), "");
    assert.equal(trustedCoverTintUrl(
        "https://streamingsoundtracks.com/images/cover/500/a.jpg", env), "");
    assert.equal(trustedCoverTintUrl(
        "https://streamingsoundtracks.com/images/cover/40/a.jpg", env), "");
    assert.equal(trustedCoverTintUrl(
        "https://streamingsoundtracks.com/images/cover/a.jpg?cache-bust=1", env), "");
});

test("returns a cacheable tint for a bounded trusted image", async () => {
    let fetchedUrl = "";
    const handler = createTintHandler({
        env: {
            TINT_ALLOWED_HOSTS: "streamingsoundtracks.com",
            BACKDROP_ALLOWED_ORIGINS: "https://example.test",
        },
        fetchImpl: async (url, init) => {
            fetchedUrl = String(url);
            assert.equal(init.redirect, "manual");
            return new Response(new Uint8Array([1, 2, 3]), {
                headers: { "content-type": "image/jpeg", "content-length": "3" },
            });
        },
        tintFromBytes: async (bytes) => {
            assert.deepEqual([...bytes], [1, 2, 3]);
            return [12, 34, 56];
        },
    });
    const res = mockResponse();
    await handler(mockRequest({
        url: "https://streamingsoundtracks.com/images/cover/B000FBFTCS.jpg",
    }, { headers: { origin: "https://example.test" } }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { tint: [12, 34, 56] });
    assert.match(fetchedUrl, /\/images\/cover\/B000FBFTCS\.jpg$/);
    assert.equal(res.headers.get("access-control-allow-origin"), "https://example.test");
    assert.match(res.headers.get("cache-control"), /s-maxage=/);
});

test("blocks redirects outside the cover allowlist", async () => {
    let requests = 0;
    const handler = createTintHandler({
        env: { TINT_ALLOWED_HOSTS: "streamingsoundtracks.com" },
        fetchImpl: async () => {
            requests++;
            return new Response(null, {
                status: 302,
                headers: { location: "http://127.0.0.1/private.jpg" },
            });
        },
    });
    const res = mockResponse();
    await handler(mockRequest({
        url: "https://streamingsoundtracks.com/images/cover/B000FBFTCS.jpg",
    }), res);
    assert.equal(requests, 1);
    assert.equal(res.statusCode, 502);
    assert.deepEqual(JSON.parse(res.body), { error: "image_redirect_not_allowed" });
    assert.equal(res.headers.get("cache-control"), "no-store");
});

test("rejects oversized cover responses before decoding", async () => {
    let decoded = false;
    const handler = createTintHandler({
        env: { TINT_ALLOWED_HOSTS: "streamingsoundtracks.com" },
        fetchImpl: async () => new Response(new Uint8Array([1]), {
            headers: { "content-type": "image/jpeg", "content-length": String(2 * 1024 * 1024 + 1) },
        }),
        tintFromBytes: async () => { decoded = true; return [1, 2, 3]; },
    });
    const res = mockResponse();
    await handler(mockRequest({
        url: "https://streamingsoundtracks.com/images/cover/B000FBFTCS.jpg",
    }), res);
    assert.equal(res.statusCode, 413);
    assert.deepEqual(JSON.parse(res.body), { error: "image_too_large" });
    assert.equal(decoded, false);
});

test("rejects unapproved browser origins before provider access", async () => {
    let fetched = false;
    const handler = createHandler({
        env: { TMDB_API_KEY: "key", BACKDROP_ALLOWED_ORIGINS: "https://allowed.test" },
        fetchImpl: async () => { fetched = true; return response(200, {}); },
    });
    const res = mockResponse();
    await handler(mockRequest({ title: "Arrival" }, {
        headers: { origin: "https://attacker.test" },
    }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(fetched, false);
    assert.equal(res.headers.get("cache-control"), "no-store");
});
