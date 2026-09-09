"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {createHandler} = require("./_lib/backdrop");
const hd = "https://assets.fanart.tv/fanart/movies/157336/moviebackground/interstellar-hd.jpg";
// Current fanart 4K entries can use this flat path, not only /movies/... paths.
const uhd = "https://assets.fanart.tv/fanart/interstellar-687c251d91fd3.jpg";
const poster = "https://assets.fanart.tv/fanart/movies/157336/movieposter/interstellar.jpg";
function artwork(url, lang = "", likes = "2") { return {url, lang, likes}; }
async function resolve(query, images = {}, type = "movie") {
    let preview, providerCalls = 0;
    const handler = createHandler({
        env: {TMDB_READ_TOKEN: "test", FANART_API_KEY: "test"},
        fetchImpl: async url => {
            ++providerCalls;
            url = String(url);
            let body;
            if (url.includes("search/multi")) body = {results: [{id:157336, media_type:type,
                title:"Interstellar", name:"Interstellar", backdrop_path:"/hd.jpg",poster_path:"/poster.jpg"}]};
            else if (url.includes("external_ids")) body = {tvdb_id:42};
            else if (url.includes("webservice.fanart.tv")) body = images;
            else throw Error("Unexpected provider request");
            return new Response(JSON.stringify(body));
        },
        tintForImage: async url => { preview = url; return [10,20,30]; },
    });
    const res = {setHeader(){}, end(value){this.body=JSON.parse(value);}};
    await handler({method:"GET",headers:{},query:{album:"Interstellar",providers:"fanart,tmdb",
        media_hint:type,...query}}, res);
    return {...res, preview, providerCalls};
}
const both = {moviebackground:[artwork(hd)],movie4kbackground:[artwork(uhd)],movieposter:[artwork(poster)]};
test("4K fanart is selected only when a physical viewport exceeds HD", async () => {
    for (const query of [{},{width:"1920",height:"1080"},{width:"1280",height:"720"}]) {
        const res = await resolve(query,both);
        assert.equal(res.statusCode,200);assert.equal(res.body.backdrop,hd);
    }
    for (const query of [{width:"3840",height:"2160"},{width:"2560",height:"1440"},
        {width:"1921",height:"1080"},{width:"1920",height:"1081"}]) {
        const res = await resolve(query,both);
        assert.equal(res.statusCode,200);assert.equal(res.body.backdrop,uhd);
        assert.equal(res.preview,uhd.replace("/fanart/","/preview/"));
    }
});
test("4K selection preserves textless/likes ranking and safe URLs", async () => {
    const res = await resolve({width:"3840",height:"2160"},{...both,movie4kbackground:[
        artwork("https://evil.example/a.jpg","","999"),artwork(uhd,"","2"),
        artwork(uhd.replace(".jpg","-text.jpg"),"en","99"),
    ]});
    assert.equal(res.body.backdrop,uhd);
});
test("missing 4K art falls back to HD, while portrait still prefers a real poster", async () => {
    const dimensions = {width:"3840",height:"2160"};
    assert.equal((await resolve(dimensions,{moviebackground:[artwork(hd)]})).body.backdrop,hd);
    const portraitDimensions = {width:"2160",height:"3840"};
    assert.equal((await resolve(portraitDimensions,both)).body.backdrop,poster);
    const res = await resolve(portraitDimensions,
        {moviebackground:[artwork(hd)],movie4kbackground:[artwork(uhd)]});
    // A later provider's actual poster still wins over fanart's landscape fallback.
    assert.equal(res.body.backdrop,"https://image.tmdb.org/t/p/w780/poster.jpg");
    assert.equal((await resolve({...portraitDimensions,providers:"fanart"},
        {movie4kbackground:[artwork(uhd)]})).body.backdrop,uhd);
});

test("viewport alone determines portrait, landscape and square artwork", async () => {
    for (const [query, expected] of [
        [{width:"720",height:"1080"},poster],
        [{width:"1080",height:"720"},hd],
        [{width:"1080",height:"1080"},hd],
        [{width:"2160",height:"2160"},uhd],
        // An obsolete orientation flag is ignored, never an override or a hint.
        [{width:"720",height:"1080",orientation:"landscape"},poster],
        [{width:"1920",height:"1080",orientation:"portrait"},hd],
        [{orientation:"portrait"},hd],
    ]) {
        const res = await resolve(query,both);
        assert.equal(res.statusCode,200);
        assert.equal(res.body.backdrop,expected);
    }
});
test("TV shows select show4kbackground through their TVDB identity", async () => {
    const res = await resolve({width:"3840",height:"2160"},
        {showbackground:[artwork(hd)],show4kbackground:[artwork(uhd)]},"tv");
    assert.equal(res.statusCode,200);assert.equal(res.body.backdrop,uhd);
});
test("invalid or incomplete viewport hints are rejected before provider access", async () => {
    for (const query of [{width:"3840"},{height:"2160"},{width:"0",height:"2160"},
        {width:"8193",height:"2160"},{width:"1.5",height:"2160"},
        {width:"NaN",height:"1080"},{width:"-1",height:"1080"}]) {
        const res = await resolve(query,both);
        assert.equal(res.statusCode,400);assert.equal(res.body.error,"invalid_viewport");
        assert.equal(res.providerCalls,0);
    }
});
