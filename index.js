'use strict'

let BROADCAST = false;
let START_TIME = 0;
let DEBUG = false;
let TRACE = false;

for(let val of process.argv) {
    switch(val) {
    case "broadcast" :
        BROADCAST = true;
        break;
    case "debug" :
        DEBUG = true;
        break;
    case "trace" :
        TRACE = true;
        DEBUG = true;
        break;
    }
}

if(typeof process.env.DEBUG == "undefined") {
    let dbgNamespace = "reward:err,reward:wrn,reward:inf";
    if(DEBUG) {
        dbgNamespace += ",reward:dbg";
    }
    if(TRACE) {
        dbgNamespace += ",reward:trc";
    }
    require("debug").enable(dbgNamespace);
}
const golos = require("golos-js");

const error = require("debug")("reward:err");
const info = require("debug")("reward:inf");
const debug = require("debug")("reward:dbg");
const trace = require("debug")("reward:trc");
const warn = require("debug")("reward:wrn");
const fs = require("fs");

const CONFIG_FILE = "config.json";
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
const REWARD_SUBSCRIBERS_REPORT = "rwrds_report";

golos.config.set('websocket', CONFIG.websocket);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function saveReport(report) {
    let saved = false;
    for(let i = 0; !saved && i < 10; i++) {
        try {
            //store
            let json = JSON.stringify(report);
            debug("save json " + json);
            if(BROADCAST) {
                await golos.broadcast.customJsonAsync(CONFIG.wif, [CONFIG.account], [], 
                    REWARD_SUBSCRIBERS_REPORT, json);
            } else {
                info("no broadcasting, don't save json!");
            }
            saved = true;
        } catch(e) {
            error(e);
            sleep(3000);
        }
    }
}

async function prompt() {

    var stdin = process.stdin,
        stdout = process.stdout;

    return new Promise(resolve => {
        stdin.resume();
        stdin.once('data', function (data) {
            resolve();
        });
    });
}

async function run() {
    try {

        //plausibility checks
        if(CONFIG.percentage + CONFIG.owner_percentage > 100) {
            error("percentage and owner_percentage > 100");
            process.exit(-1);
        }


        let props = await golos.api.getDynamicGlobalPropertiesAsync();
        START_TIME = Date.parse(props.time) - (1000 * 60 * 60 * 24 * 7);

        let acc = await golos.api.getAccountsAsync([CONFIG.account]);
        let balance = parseFloat(acc[0].sbd_balance.split(" ")[0]);

        info("user", CONFIG.account);
        info("websocket", CONFIG.websocket);
        info("broadcast", BROADCAST);
        info("current server time ", new Date(Date.parse(props.time)).toISOString());
        info("earliest activity time " + new Date(START_TIME).toISOString());
        info("GBG balance " + balance.toFixed(3));
        info("------------------------------------------\n");

        info("collect subscribers...");
        let subscribers = await getSubscribers();
        subscribers.sort();
        subscribers = await filter(subscribers);
        if(subscribers.length == 0) {
            info("no subscribers, no transfer!");
            return;
        }
        const rewards = balance * CONFIG.percentage / 100;
        const owner_fee = balance * CONFIG.owner_percentage / 100;
        const fee = rewards / subscribers.length;

        info(`
    *******************************************************************
    * Balance            : ${balance.toFixed(3)} GBG
    * Reward sum         : ${rewards.toFixed(3)} GBG (${CONFIG.percentage}%)
    * Owner              : ${CONFIG.owner}
    * Owner fee          : ${owner_fee.toFixed(3)} GBG (${CONFIG.owner_percentage}%)
    * Subscribers        : ${subscribers.length}
    * Fee per subscriber : ${fee.toFixed(3)}
    ******************************************************************
    ${(!BROADCAST?"Broadcasting is not enabled! NO transfers. Add \"broadcast\" parameter":"")}
    Press any key to do transfer or Ctrl-C to terminate...
`);
        if(!BROADCAST) {
            await prompt();
        } else {
            info("Broadcasting enabled, start transferring in 5 sec.");
            await sleep(5000);
        }

        await transfer(subscribers, fee);

        if(BROADCAST && owner_fee > 0.001) {
            info("transfer owner fee to " + CONFIG.owner + " " + owner_fee.toFixed(3));
            const memo = `owner fee ${CONFIG.owner_percentage}% of ${balance.toFixed(3)} GBG`;
            await golos.broadcast.transferAsync(CONFIG.wif, CONFIG.account, CONFIG.owner, owner_fee.toFixed(3) + " GBG", memo);
        } else {
            info("no broadcasting, owner fee will not be transfered!");
        }

        await saveReport({
            balance : `${balance.toFixed(3)} GBG`,
            reward_sum : `${rewards.toFixed(3)} GBG (${CONFIG.percentage}%)`,
            owner_fee : `${owner_fee.toFixed(3)} GBG (${CONFIG.owner_percentage}%)`,
            subscribers : subscribers.length,
            subscriber_fee : `${fee.toFixed(3)} GBG`
        });

        info("DONE!");
        process.exit(0);
    } catch(e) {
        error(e);
        error(getExceptionCause(e));
        process.exit(1);
    }
}

async function getSubscribers() {
    let subscribers = []
    const LIMIT = 100;
    let from = "";

    let add = (fs) => {
        for(let f of fs) {
            if(!subscribers.includes(f.follower)) {
                trace("add follower " + f.follower);
                subscribers.push(f.follower);
            }
        }
    }

    let buffer = await golos.api.getFollowersAsync(CONFIG.account, from, "blog", LIMIT);
    
    while(buffer.length == LIMIT) {
        from = buffer[buffer.length-1].follower;
        add(buffer);
        buffer = await golos.api.getFollowersAsync(CONFIG.account, from, "blog", LIMIT);
    }

    if(buffer.length > 0) {
        add(buffer);
    }

    return subscribers;
}

function log10(str) {
    const leadingDigits = parseInt(str.substring(0, 4));
    const log = Math.log(leadingDigits) / Math.LN10 + 0.00000001
    const n = str.length - 1;
    return n + (log - parseInt(log));
}

function repLog10(rep2) {
    if(rep2 == null) return rep2
    let rep = String(rep2)
    const neg = rep.charAt(0) === '-'
    rep = neg ? rep.substring(1) : rep

    let out = log10(rep)
    if(isNaN(out)) out = 0
    out = Math.max(out - 9, 0); // @ -9, $0.50 earned is approx magnitude 1
    out = (neg ? -1 : 1) * out
    out = (out * 9) + 25 // 9 points per magnitude. center at 25
    // base-line 0 to darken and < 0 to auto hide (grep rephide)
    return out
}

class ActivityScanner {
    constructor(userid) {
        this.found = false;
        this.userid = userid;
    }

    async process(he) {
        const tr = he[1];
        const time = Date.parse(tr.timestamp);
        if(this.found || time < START_TIME) {
            return true;
        }

        const op = tr.op[0];
        const opBody = tr.op[1];
        trace("op = " + op + ", opBody = " + JSON.stringify(opBody));
        switch(op) {
            case "vote" :
                if(opBody.voter == this.userid) {
                    this.found = true;
                }
                break;
            case "comment" : 
                if(opBody.author == this.userid) {
                    this.found == true;
                }
                break;
            case "custom_json" :
                if(opBody.id == "follow") {
                    let json = JSON.parse(opBody.json);
                    if(json[0] == "reblog" && json[1].account == this.userid) {
                        this.found = true;
                    }
                }
                break;
        }
        return this.found;
    }
}

async function checkActivity(acc) {
    const userid = acc.name;

    const scanner = new ActivityScanner(userid);
    await scanUserHistory(userid, scanner);
    
    return scanner.found;
}

async function checkAccount(acc) {

    for(let re of CONFIG.blacklist) {
        if(acc.name.match(re)) {
            debug("BLACKLIST  : " + acc.name);
            return false;
        }
    }

    let nrep = repLog10(acc.reputation);
    if(CONFIG.minrep > nrep) {
        debug("LOWREP     : " + acc.name + " - " + nrep.toFixed(2));
        return false;
    }

    if(!await checkActivity(acc)) {
        debug("NOACTIVITY : " + acc.name);
        return false;
    }

    return true;
}

async function filter(subscribers) {
    const ret = [];
    const len = subscribers.length;
    let count = 20;
    let i = 0;
    while(i < len) {
        let count = Math.min(7, len - i);
        let query = []
        for(let n = 0; n < count; n++ ) {
            query.push(subscribers[i+n]);
        }
        let answer = await golos.api.getAccountsAsync(query);
        for(let acc of answer) {
            if(await checkAccount(acc)) {
                ret.push(acc.name);
            }
        }
        i += count;
    }

    return ret;
}

async function transfer(subscribers, fee) {
    debug("transfer " + fee);
    const amount = fee.toFixed(3) + " GBG";
    for(let userid of subscribers) {
        if(BROADCAST) {
            info("transfer to " + userid + " " + amount + " with memo " + CONFIG.message);
            await golos.broadcast.transferAsync(CONFIG.wif, CONFIG.account, userid, amount, CONFIG.message);
        } else {
            debug("no broadcast!, transfer to " + userid + " " + amount + " with memo " + CONFIG.message);
        }
    }
}

async function calculateFee(count) {
    return 10.1;
}

const SCAN_BLOCK = 50;
async function scanUserHistory(userid, scanner) {

        //scan user history backwards, and collect transfers
        let start = -1;
        let count = SCAN_BLOCK;
        trace("scan history, userid = " + userid);
        while(start == -1 || start > 0) {
            trace("\n\n\nget history start = "+ start + ", count = " + count);
            let userHistory = await golos.api.getAccountHistoryAsync(userid, start, count);
            if(!(userHistory instanceof Array)) {
                error("not an array");
                return;
            }
            let firstReadId = userHistory[0][0];
            trace("first id = " + firstReadId);
            let terminate = false;
            for(let h = 0; h < userHistory.length; h++) {
                trace("check hist id " + userHistory[h][0] + " / " + userHistory[h][1].op[0]);
                if(await scanner.process(userHistory[h])) {
                    if(!terminate) {
                        terminate = true;
                    }
                }
            }
            trace("scanning done = " + terminate);

            start = firstReadId -1;
            if(terminate || start <= 0) {
                break;
            }            
            count = (start > SCAN_BLOCK)?SCAN_BLOCK:start;
        }
}

function getExceptionCause(e) {
    if(e.cause && e.cause.payload && e.cause.payload.error) {
        let m = e.cause.payload.error.message; 
        if(m) {
            let am = m.split("\n");
            m = am[0];
            for(let i = 1; i < am.length && i < 3; i++) {
                m += ": " + am[i];
            }
            return m;
        }
    }
    return e;
}

run();































