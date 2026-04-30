we are receiving a cid .. that is dag-cbor from lit main action
this cid contains a website structure
we will transform this structure into a structure that can be uoploaded as dag-pb, so as to work with dnslink:ipfs://<cid> and display a navigatable webiste in the browser
we use the pinata api and methods in 0xObsidian/src/ipfs/pinata.ctrlr.ts
0xObsidian/src/ipfs/pinata.factory.ts
we can add methods in those files

considerations:
we want a similar process to work when but one file is changed.
we would re-use the cids
ideally we do not want to write files to disc locally

lets add logging
we can use files ipfs-migration.strategy.ts + ipfs-fs.strategy
