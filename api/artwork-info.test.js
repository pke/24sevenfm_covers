"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHandler } = require("./_lib/backdrop");
const poster = "https://assets.fanart.tv/fanart/flat-poster.jpg";
const background = "https://assets.fanart.tv/fanart/flat-background.jpg";
function fixture(images) {
    let calls = 0;
    const handler = createHandler({
        env: { TMDB_READ_TOKEN: "test", FANART_API_KEY: "test" },
        fetchImpl: async url => {
            calls++;
            if (String(url).includes("search/multi")) return Response.json({results: [
                {id: 1, media_type: "movie", title: "Film", backdrop_path: "/back.jpg", poster_path: "/poster.jpg"},
            ]});
            if (String(url).includes("webservice.fanart.tv")) return Response.json(images);
            throw Error("Unexpected provider request");
        },
        tintForImage: async () => [10, 20, 30],
    });
    return {
        calls: () => calls,
        async get(options = {}) {
            const res = {setHeader(){}, end(value){this.body=JSON.parse(value);}};
            await handler({method:"GET", headers:{}, query:{album:"Film", providers:"fanart",
                media_hint:"movie", width:"240", height:"320", artwork_info:"1", ...options}}, res);
            return res;
        },
    };
}
test("selected Fanart poster retains language and explicit text presence, including flat CDN URLs", async () => {
    for (const [lang, language, containsText] of [["en","en",true],["de","de",true],
        ["00","00",false],["","00",false],[undefined,null,null],["invalid",null,null]]) {
        const f = fixture({movieposter:[{url:poster, lang}]});
        const res = await f.get();
        assert.equal(res.statusCode,200);
        assert.equal(res.body.backdrop,poster);
        assert.deepEqual(res.body.artwork,{kind:"poster",language,containsText});
        assert.equal(f.calls(),2,"Reuse existing artwork payload; no extra provider call");
    }
});
test("selection still prefers textless art; metadata comes from the selected candidate", async () => {
    const f=fixture({movieposter:[{url:poster,lang:"en",likes:"90"},
        {url:poster.replace("poster","textless"),lang:"00",likes:"1"}]});
    const res=await f.get();
    assert.match(res.body.backdrop,/textless/);
    assert.deepEqual(res.body.artwork,{kind:"poster",language:"00",containsText:false});
});
test("portrait fallback retains background type; another provider never inherits Fanart metadata", async () => {
    const f=fixture({moviebackground:[{url:background,lang:"00"}]});
    assert.deepEqual((await f.get()).body.artwork,{kind:"background",language:"00",containsText:false});
    const res=await f.get({providers:"fanart,tmdb"});
    assert.equal(res.body.source,"tmdb");assert.equal(res.body.artwork,undefined);
});
test("artwork_info is an opt-in projection; response variants share the same cached selection", async () => {
    const f=fixture({movieposter:[{url:poster,lang:"en"}]});
    assert.equal((await f.get()).body.artwork.containsText,true);
    for(const value of ["0",undefined])assert.equal((await f.get({artwork_info:value})).body.artwork,undefined);
    assert.equal((await f.get()).body.artwork.containsText,true);
    assert.equal(f.calls(),2);
    assert.equal((await f.get({art:"0"})).body.artwork,undefined);
    for(const value of ["", "true", "2"])assert.equal((await f.get({artwork_info:value})).statusCode,400);
});
