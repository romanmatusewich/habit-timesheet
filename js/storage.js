/*
 * Habit Timesheet storage layer.
 * This module intentionally exposes the current storage helpers without
 * changing their public behavior. The next refactor step can replace the
 * implementation behind this boundary safely.
 */
(function(window){
  'use strict';

  function read(key,fallback){
    try{
      var value=localStorage.getItem(key);
      if(!value)return JSON.parse(JSON.stringify(fallback));
      return JSON.parse(value);
    }catch(e){
      return JSON.parse(JSON.stringify(fallback));
    }
  }

  function cloneData(value){return JSON.parse(JSON.stringify(value))}
  function notifyDataChanged(){
    try{if(dataChannel)dataChannel.postMessage({type:'data-changed'})}catch(e){}
  }

  function resetInvalidFilters(){
    var changed=false;
    if(calendarFilterHabitId!=='*'&&!habits.some(function(h){return h.id===calendarFilterHabitId})){calendarFilterHabitId='*';changed=true}
    if(recordsFilterHabitId!=='*'&&!habits.some(function(h){return h.id===recordsFilterHabitId})){recordsFilterHabitId='*';changed=true}
    if(chosenHabit&&!habits.some(function(h){return h.id===chosenHabit})){chosenHabit=habits[0]?habits[0].id:'';changed=true}
    if(changed)saveUIState();
  }

  function syncFromLocalStorage(){
    try{
      var nextHabits=normalizeStoredHabits(JSON.parse(localStorage.getItem(HABITS_KEY)||'[]'));
      var nextEntries=normalizeStoredEntries(JSON.parse(localStorage.getItem(ENTRIES_KEY)||'[]'));
      if(!Array.isArray(nextHabits)||!Array.isArray(nextEntries))return;
      habits=nextHabits;
      entries=nextEntries;
      resetInvalidFilters();
      selectedEntryIds={};
      entrySelectionMode=false;
      entryRenderLimit=Math.min(entryRenderLimit,Math.max(60,entries.length));
      menusDirty=true;
      invalidateDataCaches();
      renderActiveView();
    }catch(e){}
  }


  function backupToLocalStorage(){
    try{
      localStorage.setItem(HABITS_KEY,JSON.stringify(habits));
      localStorage.setItem(ENTRIES_KEY,JSON.stringify(entries));
      return true;
    }catch(e){return false}
  }

  function scheduleLocalBackup(){
    if(storageMode!=='indexeddb')return;
    clearTimeout(localBackupTimer);
    localBackupTimer=setTimeout(function(){
      localBackupTimer=0;
      if(typeof requestIdleCallback==='function'){
        requestIdleCallback(function(){backupToLocalStorage()},{timeout:1200});
      }else{
        backupToLocalStorage();
      }
    },750);
  }

  function idbRequest(request){
    return new Promise(function(resolve,reject){
      request.onsuccess=function(){resolve(request.result)};
      request.onerror=function(){reject(request.error||new Error('IndexedDB error'))};
    });
  }

  function openIndexedDB(){
    return new Promise(function(resolve,reject){
      if(!window.indexedDB){reject(new Error('IndexedDB unavailable'));return}
      var request=indexedDB.open(IDB_NAME,IDB_VERSION);
      request.onupgradeneeded=function(event){
        var database=event.target.result,transaction=event.target.transaction,oldVersion=event.oldVersion||0;
        if(oldVersion<1){
          if(!database.objectStoreNames.contains(IDB_HABITS))database.createObjectStore(IDB_HABITS,{keyPath:'id'});
          if(!database.objectStoreNames.contains(IDB_ENTRIES))database.createObjectStore(IDB_ENTRIES,{keyPath:'id'});
          if(!database.objectStoreNames.contains(IDB_META))database.createObjectStore(IDB_META,{keyPath:'key'});
        }
        if(oldVersion<2){
          var meta=transaction.objectStore(IDB_META);
          meta.put({key:'schemaVersion',value:2});
        }
      };
      request.onsuccess=function(){
        var opened=request.result;
        opened.onversionchange=function(){opened.close();if(db===opened)db=null;};
        resolve(opened);
      };
      request.onerror=function(){reject(request.error||new Error('IndexedDB open failed'))};
    });
  }

  function idbGetAll(storeName){
    return idbRequest(db.transaction(storeName,'readonly').objectStore(storeName).getAll());
  }

  function idbGetMeta(key){
    return idbRequest(db.transaction(IDB_META,'readonly').objectStore(IDB_META).get(key));
  }

  function idbStoreAll(habitData,entryData){
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

  function queueIDBWrite(operation){
    storageWriteChain=storageWriteChain.then(operation).catch(function(){
      storageMode='local';
      backupToLocalStorage();
      showToast('Резервная копия данных сохранена локально');
    });
    return storageWriteChain;
  }

  function persistHabits(){
    localMutationEpoch++;
    if(storageMode==='indexeddb'){
      var batch=cloneData(habits);
      queueIDBWrite(function(){
        return new Promise(function(resolve,reject){
          var tx=db.transaction(IDB_HABITS,'readwrite');
          var store=tx.objectStore(IDB_HABITS);
          store.clear();
          for(var i=0;i<batch.length;i++)store.put(batch[i]);
          tx.oncomplete=function(){resolve()};
          tx.onerror=function(){reject(tx.error||new Error('IndexedDB habits save failed'))};
          tx.onabort=function(){reject(tx.error||new Error('IndexedDB habits save aborted'))};
        });
      });
      backupToLocalStorage();
      notifyDataChanged();
      scheduleLocalBackup();
      return true;
    }
    return backupToLocalStorage();
  }

  function persistEntries(){
    localMutationEpoch++;
    if(storageMode==='indexeddb'){
      var batch=cloneData(entries);
      backupToLocalStorage();
      notifyDataChanged();
      queueIDBWrite(function(){
        return new Promise(function(resolve,reject){
          var tx=db.transaction(IDB_ENTRIES,'readwrite');
          var store=tx.objectStore(IDB_ENTRIES);
          for(var i=0;i<batch.length;i++)store.put(batch[i]);
          tx.oncomplete=function(){resolve()};
          tx.onerror=function(){reject(tx.error||new Error('IndexedDB entries save failed'))};
          tx.onabort=function(){reject(tx.error||new Error('IndexedDB entries save aborted'))};
        });
      });
      return true;
    }
    notifyDataChanged();
    return backupToLocalStorage();
  }

  function persistAll(){
    localMutationEpoch++;
    if(storageMode==='indexeddb'){
      backupToLocalStorage();
      notifyDataChanged();
      queueIDBWrite(function(){return idbStoreAll(cloneData(habits),cloneData(entries))});
      scheduleLocalBackup();
      return true;
    }
    return backupToLocalStorage();
  }


  function cleanLegacyImportedData(){
    // Legacy cleanup was intentionally retired. Imported records are user data
    // and must not be removed automatically on startup.
    return false;
  }

  function deleteEntriesFromStorage(ids){
    if(!ids.length)return true;
    localMutationEpoch++;
    if(storageMode==='indexeddb'){
      var batch=ids.slice();
      queueIDBWrite(function(){
        return new Promise(function(resolve,reject){
          var tx=db.transaction(IDB_ENTRIES,'readwrite'),store=tx.objectStore(IDB_ENTRIES);
          for(var i=0;i<batch.length;i++)store.delete(batch[i]);
          tx.oncomplete=function(){resolve()};
          tx.onerror=function(){reject(tx.error||new Error('IndexedDB batch delete failed'))};
          tx.onabort=function(){reject(tx.error||new Error('IndexedDB batch delete aborted'))};
        });
      });
      notifyDataChanged();
      backupToLocalStorage();
      scheduleLocalBackup();
      return true;
    }
    notifyDataChanged();
    return backupToLocalStorage();
  }

  function deleteEntryFromStorage(id){
    localMutationEpoch++;
    if(storageMode==='indexeddb'){
      queueIDBWrite(function(){
        return idbRequest(db.transaction(IDB_ENTRIES,'readwrite').objectStore(IDB_ENTRIES).delete(id));
      });
      notifyDataChanged();
      backupToLocalStorage();
      scheduleLocalBackup();
      return true;
    }
    notifyDataChanged();
    return backupToLocalStorage();
  }

  function deleteHabitFromStorage(id){
    localMutationEpoch++;
    if(storageMode==='indexeddb'){
      queueIDBWrite(function(){
        return new Promise(function(resolve,reject){
          var tx=db.transaction([IDB_HABITS,IDB_ENTRIES],'readwrite');
          tx.objectStore(IDB_HABITS).delete(id);
          var request=tx.objectStore(IDB_ENTRIES).openCursor();
          request.onsuccess=function(event){
            var cursor=event.target.result;
            if(!cursor)return resolve();
            if(cursor.value.habitId===id)cursor.delete();
            cursor.continue();
          };
          tx.oncomplete=function(){resolve()};
          tx.onerror=function(){reject(tx.error||new Error('IndexedDB delete failed'))};
          tx.onabort=function(){reject(tx.error||new Error('IndexedDB delete aborted'))};
        });
      });
      notifyDataChanged();
      backupToLocalStorage();
      scheduleLocalBackup();
      return true;
    }
    notifyDataChanged();
    return backupToLocalStorage();
  }

  function normalizeStoredHabits(list){
    return list.map(function(h){
      return {id:h.id,name:String(h.name||'Привычка'),goal:Number(h.goal)||30,color:COLOR_BY_ID[h.color]?h.color:null};
    });
  }

  function normalizeStoredEntries(list){
    return list.map(function(e){
      return {id:e.id||uid(),habitId:e.habitId,date:e.date,minutes:Math.max(0,Number(e.minutes)||0),note:e.note||'',type:e.type||'active',color:e.color||'yellow'};
    });
  }

  async function reconcileFromIndexedDB(){
    var epoch=localMutationEpoch;
    var idbHabits=await idbGetAll(IDB_HABITS);
    var idbEntries=await idbGetAll(IDB_ENTRIES);
    if(localMutationEpoch!==epoch){
      await idbStoreAll(cloneData(habits),cloneData(entries));
      return;
    }
    habits=normalizeStoredHabits(idbHabits);
    entries=normalizeStoredEntries(idbEntries);
    storageMode='indexeddb';
    if(cleanLegacyImportedData())await idbStoreAll(cloneData(habits),cloneData(entries));
    invalidateDataCaches();
    menusDirty=true;
    entryRenderLimit=Math.min(entryRenderLimit,Math.max(60,entries.length));
    renderActiveView();

  }

  function scheduleIndexedDBReconcile(){
    var run=function(){reconcileFromIndexedDB().catch(function(){});};
    if(typeof requestIdleCallback==='function'){
      requestIdleCallback(run,{timeout:1200});
    }else{
      setTimeout(run,400);
    }
  }

  async function initIndexedDB(){
    if(window.location.protocol==='file:'&&!PERF_MODE){
      window.__STORAGE_READY=true;
      return;
    }
    try{
      db=await openIndexedDB();
      var marker=await idbGetMeta('migrated');
      var schema=await idbGetMeta('schemaVersion');
      if(!schema||schema.value!==2){
        try{await idbRequest(db.transaction(IDB_META,'readwrite').objectStore(IDB_META).put({key:'schemaVersion',value:2}))}catch(e){}
      }

      if(!marker||marker.value!==true){
        var epoch=localMutationEpoch;
        await idbStoreAll(cloneData(habits),cloneData(entries));
        if(localMutationEpoch!==epoch){
          await idbStoreAll(cloneData(habits),cloneData(entries));
        }
      }else{
        await reconcileFromIndexedDB();
      }

      storageMode='indexeddb';
      try{
        await idbRequest(db.transaction(IDB_META,'readwrite').objectStore(IDB_META).delete('habit-timesheet-training-allocation-v1'));
        await idbRequest(db.transaction(IDB_META,'readwrite').objectStore(IDB_META).delete('habit-timesheet-august-allocation-v1'));
      }catch(e){}
      backupToLocalStorage();
      renderActiveView();

      scheduleLocalBackup();
      window.__STORAGE_READY=true;
    }catch(e){
      storageMode='local';
      db=null;
      window.__STORAGE_READY=true;
    }
  }


  window.HabitTimesheetStorage={
    read:read,
    cloneData:cloneData,
    notifyDataChanged:notifyDataChanged,
    resetInvalidFilters:resetInvalidFilters,
    syncFromLocalStorage:syncFromLocalStorage,
    backupToLocalStorage:backupToLocalStorage,
    scheduleLocalBackup:scheduleLocalBackup,
    idbRequest:idbRequest,
    openIndexedDB:openIndexedDB,
    idbGetAll:idbGetAll,
    idbGetMeta:idbGetMeta,
    idbStoreAll:idbStoreAll,
    queueIDBWrite:queueIDBWrite,
    persistHabits:persistHabits,
    persistEntries:persistEntries,
    persistAll:persistAll,
    cleanLegacyImportedData:cleanLegacyImportedData,
    deleteEntriesFromStorage:deleteEntriesFromStorage,
    deleteEntryFromStorage:deleteEntryFromStorage,
    deleteHabitFromStorage:deleteHabitFromStorage,
    normalizeStoredHabits:normalizeStoredHabits,
    normalizeStoredEntries:normalizeStoredEntries,
    reconcileFromIndexedDB:reconcileFromIndexedDB,
    scheduleIndexedDBReconcile:scheduleIndexedDBReconcile,
    initIndexedDB:initIndexedDB
  };
})(window);
