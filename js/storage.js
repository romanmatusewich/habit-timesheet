/* Habit Timesheet — low-level storage primitives. */
(function(window){
  'use strict';

  var IDB_NAME_BASE='habit-timesheet-db';
  var IDB_VERSION=2;
  var IDB_HABITS='habits';
  var IDB_ENTRIES='entries';
  var IDB_META='meta';

  function idbRequest(request){
    return new Promise(function(resolve,reject){
      request.onsuccess=function(){resolve(request.result)};
      request.onerror=function(){reject(request.error||new Error('IndexedDB error'))};
    });
  }

  function openIndexedDB(name){
    return new Promise(function(resolve,reject){
      if(!window.indexedDB){reject(new Error('IndexedDB unavailable'));return}
      var request=indexedDB.open(name,IDB_VERSION);
      request.onupgradeneeded=function(event){
        var database=event.target.result,transaction=event.target.transaction,oldVersion=event.oldVersion||0;
        if(oldVersion<1){
          if(!database.objectStoreNames.contains(IDB_HABITS))database.createObjectStore(IDB_HABITS,{keyPath:'id'});
          if(!database.objectStoreNames.contains(IDB_ENTRIES))database.createObjectStore(IDB_ENTRIES,{keyPath:'id'});
          if(!database.objectStoreNames.contains(IDB_META))database.createObjectStore(IDB_META,{keyPath:'key'});
        }
        if(oldVersion<2){
          transaction.objectStore(IDB_META).put({key:'schemaVersion',value:2});
        }
      };
      request.onsuccess=function(){resolve(request.result)};
      request.onerror=function(){reject(request.error||new Error('IndexedDB open failed'))};
    });
  }

  function idbGetAll(db,storeName){
    return idbRequest(db.transaction(storeName,'readonly').objectStore(storeName).getAll());
  }

  function idbGetMeta(db,key){
    return idbRequest(db.transaction(IDB_META,'readonly').objectStore(IDB_META).get(key));
  }

  function idbStoreAll(db,habitData,entryData){
    return new Promise(function(resolve,reject){
      var tx=db.transaction([IDB_HABITS,IDB_ENTRIES,IDB_META],'readwrite');
      tx.objectStore(IDB_HABITS).clear();
      tx.objectStore(IDB_ENTRIES).clear();
      for(var i=0;i<habitData.length;i++)tx.objectStore(IDB_HABITS).put(habitData[i]);
      for(var j=0;j<entryData.length;j++)tx.objectStore(IDB_ENTRIES).put(entryData[j]);
      tx.objectStore(IDB_META).put({key:'migrated',value:true});
      tx.oncomplete=function(){resolve()};
      tx.onerror=function(){reject(tx.error||new Error('IndexedDB migration failed'))};
      tx.onabort=function(){reject(tx.error||new Error('IndexedDB migration aborted'))};
    });
  }

  window.HabitTimesheetStorage={
    IDB_HABITS:IDB_HABITS,
    IDB_ENTRIES:IDB_ENTRIES,
    IDB_META:IDB_META,
    idbRequest:idbRequest,
    openIndexedDB:openIndexedDB,
    idbGetAll:idbGetAll,
    idbGetMeta:idbGetMeta,
    idbStoreAll:idbStoreAll
  };
})(window);
