// Read-only comparison; no recipient data and no network calls to LinkedIn.
const print = console.log;
console.log = () => {};
const {connectDb,closeDb} = await import('../src/config/db.js');
try {
  const db = await connectDb();
  const since = new Date(Date.now()-24*60*60*1000);
  const results = await db.collection('sourceClientComparisons').aggregate([
    {$match:{at:{$gte:since}}},
    {$group:{_id:{client:'$client',status:'$status',httpStatus:'$httpStatus'},pages:{$sum:1},
      parsedCards:{$sum:'$parsedCount'},averageMs:{$avg:'$elapsedMs'},latest:{$max:'$at'}}}
  ]).toArray();
  print(JSON.stringify({since,results},null,2));
} finally {await closeDb();}
