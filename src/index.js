const SteamUser = require("steam-user")

// const user = new SteamUser()

// user.logOn({
//     accountName: process.env.STEAM_USERNAME,
//     password: process.env.STEAM_PASSWORD,
// });

const superagent = require("superagent");
const cp = require("child_process");
const fs = require("fs");

const Scraper = require("./scraper");

const GET_PUBLISHED_FILE_DETAILS_URL = "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/"
const QUERY_FILES_URL = "https://api.steampowered.com/IPublishedFileService/QueryFiles/v1/"

async function queryFiles(tag, cursor = "*", numberPerPage = 100) {
    let query = `?key=${ process.env.STEAM_API_KEY }`;
    query += `&query_type=${ SteamUser.EPublishedFileQueryType.RankedByPublicationDate }`;
    query += `&cursor=${ encodeURIComponent(cursor) }`;
    query += `&numperpage=${ numberPerPage }`;
    query += `&appid=${ 387990 }`;
    query += `&requiredtags[0]=${ tag }`;
    // query += `&ids_only[]=${ true }`;

    const response = await superagent.get(QUERY_FILES_URL + query);

    // console.log(response.request.url);
    console.log(response.body.response);

    return response.body.response;
}

async function queryAllFiles() {
    let details = [];

    for (let tag of ["Blocks+and+Parts", "Custom+Game"]) {
        let data = await queryFiles(tag);
        details.push(...data.publishedfiledetails);
    
        while(data.publishedfiledetails) {
            data = await queryFiles(tag, data.next_cursor);
    
            if (data.publishedfiledetails) {
                details.push(...data.publishedfiledetails);
            }
        }
    }

    return details.map(d => parseInt(d.publishedfileid));
}

async function getPublishedFileDetails(ids) {
    if (ids.length === 0) {
        return { publishedfiledetails: [] };
    }

    let formData = {
        key: process.env.STEAM_API_KEY,
        itemcount: ids.length
    }
    ids.forEach((id, i) => {
        formData[`publishedfileids[${ i }]`] = id;
    });
    

    let request = superagent.post(GET_PUBLISHED_FILE_DETAILS_URL).type("form")
        .field("key", process.env.STEAM_API_KEY)
        .field("itemcount", ids.length);

    ids.forEach((id, i) => {
        request.field(`publishedfileids[${ i }]`, id);
    });

    let response = await request;
    
    return response.body.response;
}

function downloadWorkshopItems(ids, makeScript = false) {
    console.log("Downloading ids", ids.join(", "));

    return new Promise(async (resolve, reject) => {
        let params = [
            "+login", process.env.STEAM_USERNAME, process.env.STEAM_PASSWORD
        ];

        if (makeScript) {
            fs.promises.writeFile(
                "/home/steam/app/download_items.vdf",
                ids.map(id => `workshop_download_item 387990 ${id.toString()}`).join("\n"),
                { flag: "w" }    
            );

            params.push(...["+runscript", "/home/steam/app/download_items.vdf"]);
        } else {
            for (let id of ids) {
                params.push(...["+workshop_download_item", "387990", id.toString()]);
            }
        }


        params.push("+quit");

        console.log("Params:", params);



        let ls = cp.spawn("/home/steam/steamcmd/steamcmd.sh", params);
    
        ls.stdout.on("data", function (data) {
            console.log("stdout: " + data.toString());
        });
    
        ls.stderr.on("data", function (data) {
            console.log("stderr: " + data.toString());
        });
    
        ls.on("exit", function (code) {
            console.log("child process exited with code " + code.toString());
            resolve(code);
        });
    });
}

async function updateMod(appid, publishedfileid, contentfolder, changenote) {
    let vdf = "/home/steam/app/upload_workshop.vdf";

    await fs.promises.writeFile(vdf, `"workshopitem"
{
    "appid"            "${appid}"
    "publishedfileid"  "${publishedfileid}"
    "contentfolder"    "${contentfolder}"
    "changenote"       "${changenote}"
}`);

    return await new Promise(async (resolve, reject) => {
        let params = [
            "+login", process.env.STEAM_USERNAME, process.env.STEAM_PASSWORD,
            "+workshop_build_item", vdf,
            "+quit"
        ];

        console.log("Params:", params);



        let ls = cp.spawn("/home/steam/steamcmd/steamcmd.sh", params);
    
        ls.stdout.on("data", function (data) {
            console.log("stdout: " + data.toString());
        });
    
        ls.stderr.on("data", function (data) {
            console.log("stderr: " + data.toString());
        });
    
        ls.on("exit", function (code) {
            console.log("child process exited with code " + code.toString());
            resolve(code);
        });
    });
}

function getSettings() {
    return {
        SKIP_UPDATE: process.env.SKIP_UPDATE === "true",
        SKIP_DOWNLOAD: process.env.SKIP_DOWNLOAD === "true",
        SKIP_QUERY: process.env.SKIP_QUERY === "true",
    }
}

(async () => {
    const settings = getSettings();
    console.log({ settings });

    const unixNow = Math.floor(new Date().getTime() / 1000);
    const lastUpdated = JSON.parse(await fs.promises.readFile("./mod/Scripts/data/last_update.json")).unix_timestamp;
    
    const scraper = new Scraper("./mod/Scripts/data", "/home/steam/Steam/steamapps/workshop/content/387990");
    
    let queriedFiles = [];
    if (settings.SKIP_QUERY) {
        console.warn("Found SKIP_QUERY=true environment variable, skipping querying all files");
    } else {
        queriedFiles = await queryAllFiles();
    }

    const request = await getPublishedFileDetails(queriedFiles);
    const details = request.publishedfiledetails.filter(item => item.time_created > lastUpdated || item.time_updated > lastUpdated)
    const ids = details.map(item => item.publishedfileid);
    
    if (details.length > 0) {
        if (settings.SKIP_DOWNLOAD) {
            console.warn("Found SKIP_DOWNLOAD=true environment variable, skipping downloading", ids);
        } else {
            const exitCode = await downloadWorkshopItems(ids, true);
        }
    }
    
    await scraper.scrapeDescriptions();
    await scraper.scrapeShapesets();

    let changelog = scraper.createChangelog(details);

    console.log(changelog);
    await fs.promises.writeFile("/home/steam/app/changelog.json", JSON.stringify(changelog));

    if (changelog.changeCount > 0) {
        console.log("Changes found, updating workshop mod...");

        await fs.promises.writeFile("./mod/Scripts/data/last_update.json", JSON.stringify(
            {
                unix_timestamp: unixNow
            },
            null, "\t"
        ));

        if (settings.SKIP_UPDATE) {
            console.warn("Found SKIP_UPDATE=true environment variable, ignoring update request");
        } else {
            await updateMod(387990, 2504530003, "/home/steam/app/mod", changelog.messageBB);
        }
    } else {
        console.log("No changes found, leaving workshop mod as it is");
    }

    console.log("Done");
})();