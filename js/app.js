(function(){
  'use strict';

  var HABITS_KEY='habit-timesheet-habits';
  var ENTRIES_KEY='habit-timesheet-entries';
  var UI_STATE_KEY='habit-timesheet-ui-state';
  var PERF_MODE=window.__PERF_MODE===true||window.location.search.indexOf('perf=1')>=0;
  var IDB_NAME='habit-timesheet-db'+(PERF_MODE?'-perf':'')+(window.__PERF_DB_SUFFIX||'');
  var IDB_VERSION=2;
  var IDB_HABITS='habits';
  var IDB_ENTRIES='entries';
  var IDB_META='meta';
  var db=null;
  var storageMode='local';
  var storageWriteChain=Promise.resolve();
  var localBackupTimer=0;
  var localMutationEpoch=0;

  var TYPE_OPTIONS=[
    {id:'active',label:'Активное обучение',defaultColor:'blue',chartColor:'#5f63ff'},
    {id:'passive',label:'Пассивное обучение',defaultColor:'yellow',chartColor:'#e3be47'},
    {id:'sport',label:'Спорт',defaultColor:'green',chartColor:'#45c986'},
    {id:'work',label:'Работа',defaultColor:'purple',chartColor:'#8b72ff'},
    {id:'creative',label:'Творчество',defaultColor:'pink',chartColor:'#ff6aa6'},
    {id:'reading',label:'Чтение',defaultColor:'blue',chartColor:'#20b6b8'},
    {id:'other',label:'Другое',defaultColor:'blue',chartColor:'#e88a3d'}
  ];

  var COLOR_OPTIONS=[
    {id:'yellow',label:'Желтый',color:'#e3be47'},
    {id:'blue',label:'Синий',color:'#5f63ff'},
    {id:'green',label:'Зеленый',color:'#45c986'},
    {id:'purple',label:'Фиолетовый',color:'#8b72ff'},
    {id:'pink',label:'Розовый',color:'#ff6aa6'}
  ];

  var COLOR_BY_ID=COLOR_OPTIONS.reduce(function(map,item){
    map[item.id]=item.color;
    return map;
  },{});


  var DEFAULT_HABITS=[
    {id:'accounting',name:'Бухгалтерия',goal:60,color:'blue'},
    {id:'speech',name:'Дикция и речь',goal:30,color:'purple'},
    {id:'reading',name:'Чтение',goal:30,color:'yellow'},
    {id:'sport',name:'Спорт',goal:45,color:'green'}
  ];

  var habits=read(HABITS_KEY,DEFAULT_HABITS).map(function(h){
    return {id:h.id,name:String(h.name||'Привычка'),goal:Number(h.goal)||30,color:COLOR_BY_ID[h.color]?h.color:null};
  });

  var entries=read(ENTRIES_KEY,[]).map(function(e){
    return {
      id:e.id||uid(),
      habitId:e.habitId,
      date:e.date,
      minutes:Math.max(0,Number(e.minutes)||0),
      note:e.note||'',
      type:e.type||'active',
      color:e.color||'yellow'
    };
  });
  cleanLegacyImportedData();

  var savedUIState=read(UI_STATE_KEY,{});
  var savedCurrentDate=/^\d{4}-\d{2}-\d{2}$/.test(savedUIState.currentDate||'')?savedUIState.currentDate:localDate();
  var currentDate=savedCurrentDate;
  var currentView='today';
  var calendarDateSelectionActive=false;
  var calendarDate=currentDate;
  var chosenHabit=habits[0]?habits[0].id:'';
  var chosenType='active';
  var chosenColor='yellow';
  var editingEntryId='';
  var undoAction=null;
  var activeRecordActionEntryId='';
  var activeRecordActionButton=null;
  var menusDirty=true;
  var menuHTMLCache={habit:null,type:null,color:null};
  var menuOptionCache={habit:[],type:[],color:[]};
  var activeMenuKind='';
  var calendarNodes=null;
  var chartNodes=null;
  var entryRenderLimit=60;
  var selectedEntryIds={};
  var entrySelectionMode=false;
  var renderFrame=0;
  var nodeCache={};
  var calendarViewDate=/^\d{4}-\d{2}-\d{2}$/.test(savedUIState.calendarViewDate||'')?savedUIState.calendarViewDate:currentDate;
  var calendarFilterHabitId=String(savedUIState.calendarFilterHabitId||'*');
  var recordsFilterHabitId=String(savedUIState.recordsFilterHabitId||'*');

  var domCache={
    views:document.querySelectorAll('.view'),
    navs:document.querySelectorAll('[data-view]')
  };

  function $(id){
    return nodeCache[id]||(nodeCache[id]=document.getElementById(id));
  }

  function saveUIState(){
    try{
      localStorage.setItem(UI_STATE_KEY,JSON.stringify({
        currentDate:currentDate,
        calendarViewDate:calendarViewDate,
        calendarFilterHabitId:calendarFilterHabitId,
        recordsFilterHabitId:recordsFilterHabitId
      }));
    }catch(e){}
  }

  function scheduleActiveRender(){
    if(renderFrame)return;
    renderFrame=requestAnimationFrame(function(){
      renderFrame=0;
      renderActiveView();
    });
  }
  function uid(){return 'id-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,9)}

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

  var storagePrimitives=window.HabitTimesheetStorage;
  var idbRequest=storagePrimitives.idbRequest;
  var idbGetAll=function(storeName){return storagePrimitives.idbGetAll(db,storeName)};
  var idbGetMeta=function(key){return storagePrimitives.idbGetMeta(db,key)};
  var idbStoreAll=function(habitData,entryData){return storagePrimitives.idbStoreAll(db,habitData,entryData)};
  var openIndexedDB=function(){return storagePrimitives.openIndexedDB(IDB_NAME)};
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
      invalidateDataCaches();
      renderActiveView();

      scheduleLocalBackup();
      window.__STORAGE_READY=true;
    }catch(e){
      storageMode='local';
      db=null;
      window.__STORAGE_READY=true;
    }
  }

  function localDate(date){
    var d=date||new Date();
    return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);
  }

  function dateObj(value){return new Date(value+'T12:00:00')}

  function dateLabel(value){
    var d=dateObj(value);
    var months=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
    var days=['Воскресенье','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'];
    return {day:d.getDate()+' '+months[d.getMonth()],weekday:days[d.getDay()]};
  }

  function fmt(minutes){
    var n=Math.round(Number(minutes)||0),h=Math.floor(n/60),m=n%60;
    if(h===0)return m+' мин';
    return h+' ч'+(m?' '+m+' мин':'');
  }

  function russianHours(minutes){
    var value=Math.round((Number(minutes)||0)/60*10)/10;
    var whole=Math.floor(value);
    if(value>=2&&value<=4)return (value===whole?whole:value)+' часа';
    if(value===1)return '1 час';
    return (value===whole?whole:value)+' часов';
  }

  function shortHours(minutes){
    return (Math.round((minutes/60)*10)/10)+' ч';
  }

  var statisticsModule=null;

  function invalidateDataCaches(){
    if(statisticsModule)statisticsModule.invalidate();
    menuHTMLCache.habit=null;
    menuHTMLCache.type=null;
    menuHTMLCache.color=null;
  }

  function getSortedEntries(){return statisticsModule.getSortedEntries()}
  function getStats(){return statisticsModule.getStats()}
  function weekDates(end){return statisticsModule.weekDates(end)}
  function allTotals(){return statisticsModule.allTotals()}
  function getHabitBreakdownHTML(totals){return statisticsModule.getHabitBreakdownHTML(totals)}
  function getStatsBreakdownHTML(totals){return statisticsModule.getStatsBreakdownHTML(totals)}
  function weeklyStatsTotals(){return statisticsModule.weeklyStatsTotals()}
  function typeDonutData(byType,total){return statisticsModule.typeDonutData(byType,total)}
  function clean(value){
    return String(value).replace(/[&<>\"']/g,function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#039;'}[c];
    });
  }

  function ensureToast(){
    var el=document.getElementById('toast');
    if(!el){
      el=document.createElement('div');
      el.id='toast';
      el.style.cssText='position:fixed;left:50%;bottom:76px;transform:translateX(-50%);background:#161927;color:#fff;padding:10px 14px;border-radius:12px;font-size:13px;opacity:0;transition:.18s;z-index:200;pointer-events:auto';
      document.body.appendChild(el);
    }
    return el;
  }
  function showToast(text){
    var el=ensureToast();
    undoAction=null;
    el.textContent=text;el.style.opacity='1';
    clearTimeout(showToast.t);
    clearTimeout(showUndoToast.t);
    showToast.t=setTimeout(function(){el.style.opacity='0'},1600);
  }
  function showUndoToast(text,action){
    var el=ensureToast();
    undoAction=action;
    clearTimeout(showToast.t);
    clearTimeout(showUndoToast.t);
    el.innerHTML='<div class="toast-inner"><span>'+clean(text)+'</span><button type="button" class="toast-undo">Отменить</button></div>';
    el.style.opacity='1';
    el.querySelector('.toast-undo').onclick=function(){
      var fn=undoAction;undoAction=null;
      el.style.opacity='0';
      if(fn)fn();
    };
    showUndoToast.t=setTimeout(function(){undoAction=null;el.style.opacity='0'},5000);
  }

  function updateHeader(){
    var d=dateLabel(currentDate);
    $('dateDay').textContent=d.day;
    $('dateWeekday').textContent=d.weekday;
  }

  function ensureChartNodes(){
    if(chartNodes)return;
    chartNodes={bars:[],labels:[]};
    var chart=$('weekChart'),labels=$('chartLabels');
    chart.textContent='';
    labels.textContent='';
    for(var i=0;i<7;i++){
      var day=document.createElement('div');
      day.className='day';
      var bar=document.createElement('div');
      day.appendChild(bar);
      chart.appendChild(day);
      chartNodes.bars.push(bar);

      var label=document.createElement('div');
      label.className='chart-label';
      labels.appendChild(label);
      chartNodes.labels.push(label);
    }
  }

  function gradientForDay(date,total){
    if(!total)return '';
    var colorTotals=getStats().byDateColor[date]||{};
    var parts=Object.keys(colorTotals).filter(function(id){
      return (colorTotals[id]>0)&&COLOR_BY_ID[id];
    }).map(function(id){
      return {color:COLOR_BY_ID[id],minutes:colorTotals[id]};
    }).sort(function(a,b){return b.minutes-a.minutes});

    if(!parts.length)return '';
    if(parts.length===1)return 'linear-gradient(180deg,'+parts[0].color+' 0%,'+parts[0].color+' 100%)';

    var stops=[],position=0;
    for(var i=0;i<parts.length;i++){
      var part=parts[i],fraction=part.minutes/total,end=(i===parts.length-1)?100:position+fraction*100;
      stops.push(part.color+' '+position.toFixed(2)+'%');
      if(i<parts.length-1){
        var next=parts[i+1].color;
        var transition=Math.min(5,Math.max(1,(end-position)*0.18),Math.max(1,(100-end)*0.18));
        stops.push(part.color+' '+Math.max(position,end-transition).toFixed(2)+'%');
        stops.push(next+' '+Math.min(100,end+transition).toFixed(2)+'%');
      }else{
        stops.push(part.color+' 100%');
      }
      position=end;
    }
    return 'linear-gradient(180deg,'+stops.join(',')+')';
  }

  function renderChart(){
    ensureChartNodes();
    var stats=getStats();
    var dates=weekDates(currentDate),totals=dates.map(function(date){return stats.byDate[date]||0;}),weekTotal=totals.reduce(function(a,b){return a+b},0);
    $('weekSummary').textContent=russianHours(weekTotal)+' за эту неделю';

    var max=Math.max(60,Math.max.apply(Math,totals));
    var names=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
    var note=$('chartDayHoverNote');
    if(note){
      note.classList.remove('active','below');
      note.style.setProperty('--tip-shift','0px');
    }
    for(var i=0;i<7;i++){
      var date=dates[i],total=totals[i],bar=chartNodes.bars[i],day=bar.parentNode;
      day.setAttribute('data-chart-date',date);
      bar.className='bar'+(date===currentDate?' today':' muted');
      bar.style.height=total?Math.max(5,Math.round(total/max*100))+'%':'0%';
      bar.style.display=total?'block':'none';
      bar.style.background=gradientForDay(date,total)||'linear-gradient(180deg,#747aff 0%,#626cf6 36%,#505fe9 68%,#45bff2 100%)';
      bar.removeAttribute('title');
      chartNodes.labels[i].textContent=names[i];
    }
    $('chartMark').textContent=Math.round(max*.55);
  }

  function renderMainStats(){
    var stats=getStats();
    var today=stats.byDate[currentDate]||0;
    var todaySessions=stats.countByDate[currentDate]||0;
    var total=stats.total;
    var average=stats.sessionCount?Math.round(total/stats.sessionCount):0;
    var totals=allTotals();

    $('todayTotal').textContent=fmt(today);
    $('todaySessions').textContent=todaySessions+' '+(todaySessions===1?'занятие':'занятий');
    $('avgSession').textContent=fmt(average);

    $('breakdownRows').innerHTML=getHabitBreakdownHTML(totals.filter(function(x){return x.total>0}));

    var monthPrefix=currentDate.slice(0,7);
    var monthActive=stats.activeByMonth[monthPrefix]||0;
    var weekTotal=weekDates(currentDate).reduce(function(s,d){return s+dayTotal(d)},0);
    var insights=[];
    if(weekTotal)insights.push('За эту неделю накоплено <b>'+fmt(weekTotal)+'</b>.');
    if(monthActive)insights.push('В этом месяце активность была <b>'+monthActive+' '+(monthActive===1?'день':'дней')+'</b>.');
    if(stats.sessionCount>1){
      var longest=stats.longest;
      insights.push('Самое длинное занятие — <b>'+fmt(longest)+'</b>.');
    }
    $('insights').innerHTML=insights.map(function(t){return '<div class="insight"><span class="insight-mark"></span><div class="insight-text">'+t+'</div></div>'}).join('');
  }

  function renderStats(){
    var stats=getStats(),total=stats.total,active=stats.activeDays;
    $('allTotal').textContent=fmt(total);
    $('activeDays').textContent=active;
    $('allSessions').textContent=stats.sessionCount;
    $('avgDay').textContent=fmt(active?total/active:0);

    var avgSession=stats.sessionCount?Math.round(total/stats.sessionCount):0;
    $('avgSessionStats').textContent=fmt(avgSession);
    $('sessionCountNote').textContent=stats.sessionCount+' '+(stats.sessionCount===1?'занятие':'занятий');

    $('last30Total').textContent=fmt(stats.last30Total||0);
    $('last30ActiveNote').textContent=(stats.last30ActiveDays||0)+' '+(stats.last30ActiveDays===1?'активный день':'активных дней');
    $('last30Avg').textContent=fmt(stats.last30Sessions?stats.last30Total/stats.last30Sessions:0);
    $('last30SessionNote').textContent=(stats.last30Sessions||0)+' '+(stats.last30Sessions===1?'занятие':'занятий');

    $('bestDayTime').textContent=fmt(stats.bestDayTotal||0);
    $('bestDayDate').textContent=stats.bestDayDate?formatFullDate(stats.bestDayDate):'Нет данных';

    $('statsBreakdown').innerHTML=getStatsBreakdownHTML(allTotals().filter(function(x){return x.total>0}));

    var weeks=weeklyStatsTotals(),maxWeek=Math.max(60,Math.max.apply(Math,weeks.map(function(x){return x.total})));
    $('weeklyStatsChart').innerHTML=weeks.map(function(x){
      var pct=Math.max(4,Math.round(x.total/maxWeek*100));
      return '<div class="weekly-bar-wrap"><div class="weekly-bar" style="height:'+pct+'%" title="'+fmt(x.total)+'"></div></div>';
    }).join('');
    $('weeklyStatsLabels').innerHTML=weeks.map(function(x){
      var a=dateObj(x.start),b=dateObj(x.end);
      var am=a.getDate()+'.'+String(a.getMonth()+1).padStart(2,'0');
      var bm=b.getDate()+'.'+String(b.getMonth()+1).padStart(2,'0');
      return '<div class="weekly-label"><span>'+am+'–</span><span class="weekly-label-range">'+bm+'</span></div>';
    }).join('');

    var donut=typeDonutData(stats.byType,total);
    $('statsTypeDonut').style.background=donut.gradient;
    $('statsTypeDonutTotal').textContent=fmt(total);
    $('statsTypeMiniLegend').innerHTML=donut.parts.slice(0,5).map(function(x){
      return '<div class="type-mini-item"><div class="type-mini-left"><span class="type-mini-dot" style="background:'+x.color+'"></span><span>'+clean(x.label)+'</span></div><b>'+fmt(x.total)+'</b></div>';
    }).join('')||'<div class="empty">Нет данных.</div>';
  }

  function renderSettings(){
    var settingsHabits=habits.slice();
    $('settingsRows').innerHTML=settingsHabits.map(function(h){
      var color=habitColor(h);
      return '<div class="break-row"><div class="break-left"><div class="break-name" title="'+clean(h.name)+'"><span class="color-dot" style="background:'+color+';margin-right:7px;vertical-align:1px"></span>'+clean(h.name)+'</div></div><button class="secondary-action" data-remove-habit="'+h.id+'">Удалить</button></div>';
    }).join('')||'<div class="empty">Нет привычек.</div>';

    var habitMap={};
    for(var hi=0;hi<habits.length;hi++)habitMap[habits[hi].id]=habits[hi];

    var filterText='Все привычки';
    if(recordsFilterHabitId!=='*'){
      var filterHabit=habits.find(function(h){return h.id===recordsFilterHabitId});
      filterText=filterHabit?filterHabit.name:'Все привычки';
    }
    $('recordsHabitFilterButtonText').textContent=filterText;
    var filteredEntries=getSortedEntries().filter(function(e){return recordsFilterHabitId==='*'||e.habitId===recordsFilterHabitId});
    var visible=filteredEntries.slice(0,entryRenderLimit);
    $('recordsSummary').textContent=filteredEntries.length+' '+(filteredEntries.length===1?'запись':'записей');
    $('historyCountLabel').textContent=filteredEntries.length+' '+(filteredEntries.length===1?'запись':'записей');
    $('entriesRows').className=entrySelectionMode?'selection-mode':'';
    $('entriesRows').innerHTML=visible.map(function(e){
      var habit=habitMap[e.habitId];
      var color=COLOR_BY_ID[e.color]||'#6e73ff';
      var checked=selectedEntryIds[e.id]?' checked':'';
      var selector=entrySelectionMode?'<label class="record-select"><input type="checkbox" data-entry-check="'+clean(e.id)+'"'+checked+' aria-label="Выбрать запись"><span></span></label>':'';
      var displayName=habit?habit.name:'Удаленная привычка';
      var displayNote=e.note||'';
      var dateText=formatFullDate(e.date||currentDate);
      var type=TYPE_OPTIONS.find(function(t){return t.id===e.type});
      var typeLabel=type?type.label:(e.type||'Запись');
      var typeColor=type?(type.chartColor||COLOR_BY_ID[type.defaultColor]||'#6e73ff'):color;
      var noteHtml=displayNote?'<div class="record-history-note" title="'+clean(displayNote)+'">'+clean(displayNote)+'</div>':'';
      return '<div class="record-row">'+selector+
        '<span class="record-dot" style="background:'+color+'"></span>'+
        '<div class="record-info">'+
          '<div class="record-name" title="'+clean(displayName)+'">'+clean(displayName)+'</div>'+
          '<div class="record-meta"><span>'+dateText+'</span><span class="record-meta-sep">·</span><span class="record-type"><i class="record-type-dot" style="background:'+typeColor+'"></i>'+clean(typeLabel)+'</span></div>'+
          noteHtml+
        '</div>'+
        '<div class="record-history-time">'+fmt(e.minutes)+'<span class="record-history-time-label">время</span></div>'+
        '<button class="record-menu-trigger" type="button" data-record-menu="'+clean(e.id)+'" aria-haspopup="menu" aria-expanded="false" aria-label="Действия: '+clean(displayName)+'" title="Действия">'+
          '<span class="record-menu-icon" aria-hidden="true"><i></i><i></i><i></i></span>'+
        '</button>'+
      '</div>';
    }).join('')||'<div class="empty">Нет записей.</div>';

    var selectedCount=Object.keys(selectedEntryIds).filter(function(id){return selectedEntryIds[id]&&filteredEntries.some(function(e){return e.id===id})}).length;
    $('recordsSelectionCount').textContent=selectedCount?selectedCount+' выбрано':'';
    $('deleteSelectedEntries').hidden=!entrySelectionMode||!selectedCount;
    $('clearEntrySelection').hidden=!entrySelectionMode;
    $('selectAllEntries').hidden=!entrySelectionMode;
    $('selectAllEntries').disabled=!filteredEntries.length||selectedCount===filteredEntries.length;
    $('toggleEntrySelection').textContent=entrySelectionMode?'Отменить':'Выделить';

    var more=filteredEntries.length>entryRenderLimit;
    $('showMoreEntries').hidden=!more;
    if(more)$('showMoreEntries').textContent='Показать ещё · '+(filteredEntries.length-entryRenderLimit);
  }

  function updateViewVisibility(){
    for(var i=0;i<domCache.views.length;i++){
      var v=domCache.views[i];
      v.classList.toggle('active',v.id===currentView+'View');
    }
    for(var j=0;j<domCache.navs.length;j++){
      var b=domCache.navs[j];
      b.classList.toggle('active',b.getAttribute('data-view')===currentView);
    }
  }

  statisticsModule=window.HabitTimesheetStatistics.create({
    getEntries:function(){return entries},
    getHabits:function(){return habits},
    getColorById:function(){return COLOR_BY_ID},
    typeOptions:TYPE_OPTIONS,
    localDate:localDate,
    dateObj:dateObj,
    fmt:fmt,
    clean:clean,
    habitColor:habitColor,
    habitColorEnd:habitColorEnd
  });

  var calendarModule=null;

  function calendarTooltip(date,stats){
    return calendarModule?calendarModule.calendarTooltip(date,stats):'';
  }

  function renderCalendarView(){
    if(calendarModule)calendarModule.renderCalendarView();
  }

  function positionChartHoverNote(day){
    var note=$('chartDayHoverNote');if(!note||!day)return;
    if(note.parentNode!==document.body)document.body.appendChild(note);
    var rect=day.getBoundingClientRect(),pad=10,gap=7;
    note.classList.add('active');
    var nr=note.getBoundingClientRect();
    var left=Math.max(pad,Math.min(window.innerWidth-pad-nr.width,rect.left+(rect.width-nr.width)/2));
    var top=rect.top-gap-nr.height;
    if(top<pad)top=Math.min(window.innerHeight-pad-nr.height,rect.bottom+gap);
    note.style.left=Math.round(left)+'px';
    note.style.top=Math.round(Math.max(pad,top))+'px';
  }

  var chartHoverDay=null,chartHoverTimer=0;
  function clearChartHover(){
    clearTimeout(chartHoverTimer);
    chartHoverDay=null;
    var note=$('chartDayHoverNote');
    if(note)note.classList.remove('active','below');
  }

  $('weekChart').addEventListener('mouseover',function(e){
    var day=e.target.closest('[data-chart-date]');
    if(!day||day===chartHoverDay||!day.querySelector('.bar:not([style*="display: none"])'))return;
    var date=day.getAttribute('data-chart-date'),stats=getStats();
    if(!(stats.byDate[date]||0))return;
    clearTimeout(chartHoverTimer);
    chartHoverDay=day;
    chartHoverTimer=setTimeout(function(){
      if(chartHoverDay!==day)return;
      $('chartDayHoverNote').innerHTML=calendarTooltip(date,stats);
      positionChartHoverNote(day);
    },550);
  });
  $('weekChart').addEventListener('wheel',function(){clearChartHover();},{passive:true});
  $('weekChart').addEventListener('mouseout',function(e){
    var next=e.relatedTarget&&e.relatedTarget.closest?e.relatedTarget.closest('[data-chart-date]'):null;
    if(next===chartHoverDay)return;
    clearChartHover();
  });

  function renderToday(){
    var note=$('chartDayHoverNote');
    if(note&&note.parentNode!==document.body)document.body.appendChild(note);
    updateHeader();
    renderChart();
    renderMainStats();
  }

  function renderActiveView(){
    updateViewVisibility();
    if(currentView==='today')renderToday();
    else if(currentView==='calendar')renderCalendarView();
    else if(currentView==='stats')renderStats();
    else renderSettings();
  }

  function render(){
    renderActiveView();
  }

  function closeMenus(){
    $('menuPopover').classList.remove('active');
    $('menuLayer').classList.remove('active');
    activeMenuKind='';
    $('habitButton').classList.remove('open');
    $('typeButton').classList.remove('open');
    $('colorButton').classList.remove('open');
    $('calendarFilterButton').classList.remove('open');
    $('calendarFilterButton').setAttribute('aria-expanded','false');
    $('recordsHabitFilterButton').classList.remove('open');
    $('importHabitButton').classList.remove('open');
    $('importHabitButton').setAttribute('aria-expanded','false');
    $('recordsHabitFilterButton').setAttribute('aria-expanded','false');
  }

  function syncMenuSelection(){
    var nodes=menuOptionCache[activeMenuKind]||[];
    var attr=activeMenuKind==='habit'?'data-habit-option':activeMenuKind==='type'?'data-type-option':'data-color-option';
    var chosen=activeMenuKind==='habit'?chosenHabit:activeMenuKind==='type'?chosenType:chosenColor;
    for(var i=0;i<nodes.length;i++){
      var selected=nodes[i].getAttribute(attr)===chosen;
      nodes[i].classList.toggle('selected',selected);
      nodes[i].setAttribute('aria-selected',selected?'true':'false');
      nodes[i].setAttribute('tabindex',selected?'0':'-1');
    }
  }

  function buildMenu(kind){
    if(menuHTMLCache[kind]!==null)return;

    if(kind==='habit'){
      menuHTMLCache.habit='<div class="menu-section">Все привычки</div>'+
        habits.map(function(h){return '<button class="option" data-habit-option="'+h.id+'">'+clean(h.name)+'</button>';}).join('');
    }else if(kind==='type'){
      menuHTMLCache.type='<div class="menu-section">Все типы</div>'+
        TYPE_OPTIONS.map(function(t){return '<button class="option" data-type-option="'+t.id+'">'+t.label+'</button>';}).join('');
    }else{
      menuHTMLCache.color=COLOR_OPTIONS.map(function(c){
        return '<button class="option" data-color-option="'+c.id+'"><span class="color-row"><span class="color-dot" style="background:'+c.color+'"></span><span>'+c.label+'</span></span></button>';
      }).join('');
    }
  }

  function positionMenu(button){
    var menu=$('menuPopover'),rect=button.getBoundingClientRect(),edge=14,gap=8;
    var width=Math.min(rect.width,360,window.innerWidth-edge*2);
    var left=Math.min(Math.max(edge,rect.left),window.innerWidth-edge-width);
    var spaceBelow=window.innerHeight-rect.bottom-gap-edge;
    var spaceAbove=rect.top-gap-edge;
    var openBelow=spaceBelow>=180||spaceBelow>=spaceAbove;
    var maxHeight=Math.min(300,Math.max(180,openBelow?spaceBelow:spaceAbove));
    var top=openBelow?rect.bottom+gap:Math.max(edge,rect.top-gap-maxHeight);
    menu.style.left=Math.round(left)+'px';
    menu.style.top=Math.round(top)+'px';
    menu.style.width=Math.round(width)+'px';
    menu.style.maxHeight=Math.round(maxHeight)+'px';
    $('menuLayer').classList.add('active');
    menu.classList.add('active');
  }

  function showMenu(kind,buttonId){
    var menu=$('menuPopover'),button=$(buttonId);
    var same=activeMenuKind===kind&&menu.classList.contains('active');
    closeMenus();
    if(same)return;
    activeMenuKind=kind;
    buildMenu(kind);

    menu.innerHTML=menuHTMLCache[kind];
    menu.setAttribute('role','listbox');
    menu.setAttribute('aria-labelledby',button.id);
    menu.setAttribute('aria-label',kind==='habit'?'Привычки':kind==='type'?'Типы':'Цвета');
    menuOptionCache.habit=[];menuOptionCache.type=[];menuOptionCache.color=[];
    if(kind==='habit')menuOptionCache.habit=menu.querySelectorAll('[data-habit-option]');
    else if(kind==='type')menuOptionCache.type=menu.querySelectorAll('[data-type-option]');
    else menuOptionCache.color=menu.querySelectorAll('[data-color-option]');
    syncMenuSelection();
    var menuOptions=menu.querySelectorAll('.option');
    for(var oi=0;oi<menuOptions.length;oi++){
      menuOptions[oi].setAttribute('role','option');
      menuOptions[oi].setAttribute('tabindex',menuOptions[oi].classList.contains('selected')?'0':'-1');
      menuOptions[oi].setAttribute('aria-selected',menuOptions[oi].classList.contains('selected')?'true':'false');
    }
    positionMenu(button);
    button.classList.add('open');
    button.setAttribute('aria-expanded','true');
    var selectedOption=menu.querySelector('.option.selected')||menu.querySelector('.option');
    if(selectedOption)setTimeout(function(){selectedOption.focus()},0);
  }

  function showImportHabitMenu(){
    var menu=$('menuPopover'),button=$('importHabitButton'),same=activeMenuKind==='importHabit'&&menu.classList.contains('active');
    closeMenus();
    if(same)return;
    activeMenuKind='importHabit';
    menu.innerHTML='<div class="menu-section">Привязать к привычке</div>'+
      habits.map(function(h){return '<button class="option" role="option" data-import-habit-option="'+clean(h.id)+'" aria-selected="'+(h.id===$('importHabit').value?'true':'false')+'" tabindex="'+(h.id===$('importHabit').value?'0':'-1')+'">'+clean(h.name)+'</button>';}).join('');
    menu.setAttribute('role','listbox');
    menu.setAttribute('aria-labelledby','importHabitButton');
    menu.setAttribute('aria-label','Привычка для импорта');
    positionMenu(button);
    button.classList.add('open');
    button.setAttribute('aria-expanded','true');
    var selectedOption=menu.querySelector('[data-import-habit-option][aria-selected="true"]')||menu.querySelector('[data-import-habit-option]');
    if(selectedOption)setTimeout(function(){selectedOption.focus()},0);
  }

  function showRecordActionsMenu(entryId,button){
    var menu=$('menuPopover'),same=activeMenuKind==='recordActions'&&activeRecordActionEntryId===entryId&&menu.classList.contains('active');
    closeMenus();
    if(same)return;
    var entry=entries.find(function(e){return e.id===entryId});
    if(!entry)return;
    var habit=habits.find(function(h){return h.id===entry.habitId});
    activeMenuKind='recordActions';
    activeRecordActionEntryId=entryId;
    activeRecordActionButton=button;
    menu.innerHTML=(habit?'<button class="option record-action-option" role="menuitem" data-record-action="edit" data-record-entry="'+clean(entryId)+'">Изменить</button>':'')+
      '<button class="option record-action-option" role="menuitem" data-record-action="delete" data-record-entry="'+clean(entryId)+'">Удалить</button>';
    menu.setAttribute('role','menu');
    menu.removeAttribute('aria-labelledby');
    menu.setAttribute('aria-label','Действия с записью');
    var options=menu.querySelectorAll('.option');
    for(var i=0;i<options.length;i++)options[i].setAttribute('tabindex',i===0?'0':'-1');
    positionRecordActionMenu(button);
    button.classList.add('open');
    button.setAttribute('aria-expanded','true');
    if(options.length)setTimeout(function(){options[0].focus()},0);
  }

  function positionRecordActionMenu(button){
    var menu=$('menuPopover');if(!button||!menu)return;
    var rect=button.getBoundingClientRect(),edge=14,gap=6,width=Math.min(136,window.innerWidth-edge*2);
    var left=Math.min(Math.max(edge,rect.right-width),window.innerWidth-edge-width);
    var spaceBelow=window.innerHeight-rect.bottom-gap-edge,spaceAbove=rect.top-gap-edge;
    var openBelow=spaceBelow>=100||spaceBelow>=spaceAbove;
    var maxHeight=Math.min(180,Math.max(100,openBelow?spaceBelow:spaceAbove));
    var top=openBelow?rect.bottom+gap:Math.max(edge,rect.top-gap-maxHeight);
    menu.style.left=Math.round(left)+'px';
    menu.style.top=Math.round(top)+'px';
    menu.style.width=Math.round(width)+'px';
    menu.style.maxHeight=Math.round(maxHeight)+'px';
    $('menuLayer').classList.add('active');
    menu.classList.add('active');
  }

  function showRecordsHabitFilterMenu(){
    var menu=$('menuPopover'),button=$('recordsHabitFilterButton');
    var same=activeMenuKind==='recordsHabit'&&menu.classList.contains('active');
    closeMenus();
    if(same)return;
    activeMenuKind='recordsHabit';
    menu.innerHTML='<div class="menu-section">Фильтр записей</div>'+
      '<button class="option" data-records-habit-option="*">Все привычки</button>'+
      habits.map(function(h){return '<button class="option" data-records-habit-option="'+clean(h.id)+'">'+clean(h.name)+'</button>';}).join('');
    var nodes=menu.querySelectorAll('[data-records-habit-option]');
    for(var i=0;i<nodes.length;i++)nodes[i].classList.toggle('selected',nodes[i].getAttribute('data-records-habit-option')===recordsFilterHabitId);
    positionMenu(button);
    button.classList.add('open');
    button.setAttribute('aria-expanded','true');
  }

  function showCalendarFilterMenu(){
    var menu=$('menuPopover'),button=$('calendarFilterButton');
    var same=activeMenuKind==='calendarHabit'&&menu.classList.contains('active');
    closeMenus();
    if(same)return;
    activeMenuKind='calendarHabit';
    menu.innerHTML='<div class="menu-section">Все привычки</div>'+
      '<button class="option" data-calendar-habit-option="*">Все привычки</button>'+
      habits.map(function(h){return '<button class="option" data-calendar-habit-option="'+clean(h.id)+'">'+clean(h.name)+'</button>';}).join('');
    var nodes=menu.querySelectorAll('[data-calendar-habit-option]');
    for(var i=0;i<nodes.length;i++)nodes[i].classList.toggle('selected',nodes[i].getAttribute('data-calendar-habit-option')===calendarFilterHabitId);
    positionMenu(button);
    button.classList.add('open');
    button.setAttribute('aria-expanded','true');
  }

  function presetForHabit(habitName){
    var n=(habitName||'').toLowerCase();
    if(n.indexOf('спорт')>=0)return {type:'sport',color:'green'};
    if(n.indexOf('чтени')>=0)return {type:'reading',color:'yellow'};
    if(n.indexOf('бухгалтер')>=0)return {type:'active',color:'blue'};
    if(n.indexOf('дикци')>=0||n.indexOf('реч')>=0)return {type:'active',color:'purple'};
    return null;
  }

  function habitColor(habit){
    if(!habit)return COLOR_BY_ID.blue;
    if(habit.color&&COLOR_BY_ID[habit.color])return COLOR_BY_ID[habit.color];
    var preset=presetForHabit(habit.name);
    return COLOR_BY_ID[preset&&preset.color]||COLOR_BY_ID.blue;
  }

  function habitColorEnd(hex){
    var map={
      '#e3be47':'#f2d36a',
      '#5f63ff':'#49cfff',
      '#45c986':'#75e0aa',
      '#8b72ff':'#b19bff',
      '#ff6aa6':'#ff9ac4'
    };
    return map[hex]||hex;
  }

  function applySelection(habitId,typeId,colorId){
    if(habitId)chosenHabit=habitId;
    if(typeId)chosenType=typeId;
    if(colorId)chosenColor=colorId;

    var habit=habits.find(function(h){return h.id===chosenHabit});
    var type=TYPE_OPTIONS.find(function(t){return t.id===chosenType})||TYPE_OPTIONS[0];
    var color=COLOR_OPTIONS.find(function(c){return c.id===chosenColor})||COLOR_OPTIONS[0];

    $('habitButtonText').textContent=habit?habit.name:'';
    $('typeButtonText').textContent=type.label;
    $('colorButtonText').textContent=color.label;
    $('colorDot').style.background=color.color;
    syncMenuSelection();
  }

  function renderVisibleCategories(){
    var defs={sport:'спорт',accounting:'бухгалтер',reading:'чтени',speech:'дикци'},buttons=document.querySelectorAll('[data-visible-category]'),visible=0;
    for(var i=0;i<buttons.length;i++){
      var button=buttons[i],query=defs[button.getAttribute('data-visible-category')]||'';
      var habit=habits.find(function(h){return (h.name||'').toLowerCase().indexOf(query)>=0});
      button.hidden=!habit;
      if(habit)visible++;
    }
    var wrap=document.querySelector('.quick-categories');
    if(wrap)wrap.hidden=!visible;
  }

  window.addEventListener('storage',function(e){
    if(e.storageArea===localStorage&&(e.key===HABITS_KEY||e.key===ENTRIES_KEY))syncFromLocalStorage();
  });
  var dataChannel=null;
  try{
    if('BroadcastChannel' in window){
      dataChannel=new BroadcastChannel('habit-timesheet-sync');
      dataChannel.onmessage=function(e){if(e.data&&e.data.type==='data-changed')syncFromLocalStorage();};
    }
  }catch(e){dataChannel=null}

  function openSheet(){
    if(!habits.length){showToast('Сначала добавь привычку');return}
    editingEntryId='';
    $('sheetTitle').textContent='Записать данные';
    $('saveEntry').textContent='Сохранить';

    renderVisibleCategories();
    chosenHabit=habits[0].id;
    chosenType='active';
    chosenColor='blue';
    $('minutes').value='30';
    $('note').value='';
    calendarDate=currentDate;
    applySelection(chosenHabit,chosenType,chosenColor);
    $('dateButtonText').textContent=formatFullDate(currentDate);
    closeMenus();
    rememberModalFocus();
    $('sheet').hidden=false;
    document.body.classList.add('sheet-open');
    requestAnimationFrame(function(){if(!$('sheet').hidden)$('minutes').focus()});
  }

  function closeSheet(){
    editingEntryId='';
    $('sheetTitle').textContent='Записать данные';
    $('saveEntry').textContent='Сохранить';
    $('sheet').hidden=true;
    document.body.classList.remove('sheet-open');
    closeMenus();
    restoreModalFocus();
  }

  function formatFullDate(value){
    var d=dateObj(value);
    var months=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
    return d.getDate()+' '+months[d.getMonth()]+' '+d.getFullYear();
  }

  function ensureCalendarNodes(){
    if(calendarNodes)return;
    var cal=$('calendar');
    cal.innerHTML=
      '<div class="calendar-head"><div class="calendar-month" id="calendarMonth"></div><div class="cal-nav"><button data-cal-prev>‹</button><button data-cal-next>›</button></div></div>'+
      '<div class="cal-week">'+['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(function(x){return '<span>'+x+'</span>'}).join('')+'</div>'+
      '<div class="cal-days" id="calendarDays"></div>';
    var days=$('calendarDays');
    calendarNodes={month:$('calendarMonth'),days:[]};
    for(var i=0;i<42;i++){
      var button=document.createElement('button');
      button.className='cal-day';
      days.appendChild(button);
      calendarNodes.days.push(button);
    }
  }

  function renderCalendar(){
    ensureCalendarNodes();
    var d=dateObj(calendarDate),year=d.getFullYear(),month=d.getMonth();
    var monthNames=['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
    var first=new Date(year,month,1),firstDay=(first.getDay()+6)%7;
    var daysInMonth=new Date(year,month+1,0).getDate();
    var prevDays=new Date(year,month,0).getDate();
    calendarNodes.month.textContent=monthNames[month]+' '+year;

    for(var i=0;i<42;i++){
      var cellDay,muted,dateValue;
      if(i<firstDay){
        cellDay=prevDays-firstDay+i+1;
        muted=true;
        dateValue=localDate(new Date(year,month-1,cellDay));
      }else if(i<firstDay+daysInMonth){
        cellDay=i-firstDay+1;
        muted=false;
        dateValue=localDate(new Date(year,month,cellDay));
      }else{
        cellDay=i-firstDay-daysInMonth+1;
        muted=true;
        dateValue=localDate(new Date(year,month+1,cellDay));
      }
      var button=calendarNodes.days[i];
      button.className='cal-day'+(muted?' muted':'')+(dateValue===currentDate?' today':'')+(dateValue===calendarDate?' selected':'');
      button.textContent=cellDay;
      button.setAttribute('data-cal-date',dateValue);
    }
  }

  function openSheetForEntry(entryId){
    var entry=entries.find(function(e){return e.id===entryId});
    if(!entry){showToast('Запись не найдена');return}
    var habit=habits.find(function(h){return h.id===entry.habitId});
    if(!habit){showToast('У этой записи больше нет привычки');return}
    editingEntryId=entry.id;
    renderVisibleCategories();
    chosenHabit=entry.habitId;
    chosenType=entry.type||'active';
    chosenColor=entry.color||'yellow';
    calendarDate=entry.date;
    $('minutes').value=String(Math.round(Number(entry.minutes)||0));
    $('note').value=entry.note||'';
    applySelection(chosenHabit,chosenType,chosenColor);
    $('dateButtonText').textContent=formatFullDate(calendarDate);
    $('sheetTitle').textContent='Изменить запись';
    $('saveEntry').textContent='Сохранить изменения';
    closeMenus();
    rememberModalFocus();
    $('sheet').hidden=false;
    document.body.classList.add('sheet-open');
    requestAnimationFrame(function(){if(!$('sheet').hidden)$('minutes').focus()});
  }

  function saveEntry(){
    var minutes=Math.max(0,parseInt($('minutes').value||'0',10)||0);
    if(!minutes){showToast('Укажи время больше 0 минут');return}

    var targetDate=calendarDate||currentDate,todayKey=localDate(new Date());
    if(!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)||targetDate>todayKey){
      showToast('Нельзя добавить запись за будущую дату');
      return;
    }

    if(editingEntryId){
      var entryIndex=-1;
      for(var ei=0;ei<entries.length;ei++)if(entries[ei].id===editingEntryId){entryIndex=ei;break}
      if(entryIndex<0){showToast('Запись не найдена');return}
      var previousEntry=cloneData(entries[entryIndex])[0];
      entries[entryIndex]={
        id:editingEntryId,
        habitId:chosenHabit,
        date:targetDate,
        minutes:minutes,
        note:$('note').value.trim(),
        type:chosenType,
        color:chosenColor
      };
      if(!persistEntries()){
        entries[entryIndex]=previousEntry;
        showToast('Не удалось сохранить изменения');
        return;
      }
      currentDate=targetDate;
      calendarViewDate=currentDate;
      calendarDateSelectionActive=false;
      editingEntryId='';
      saveUIState();
      invalidateDataCaches();
      closeSheet();
      scheduleActiveRender();
      showToast('Запись изменена');
      return;
    }

    var entry={
      id:uid(),
      habitId:chosenHabit,
      date:targetDate,
      minutes:minutes,
      note:$('note').value.trim(),
      type:chosenType,
      color:chosenColor
    };
    entries.push(entry);

    if(!persistEntries()){
      entries.pop();
      showToast('Не удалось сохранить данные');
      return;
    }

    currentDate=targetDate;
    calendarViewDate=currentDate;
    calendarDateSelectionActive=false;
    saveUIState();
    invalidateDataCaches();
    closeSheet();
    scheduleActiveRender();
    showToast('Запись сохранена');
  }

  function getExportEntries(){
    var filtered=getSortedEntries().filter(function(e){
      return recordsFilterHabitId==='*'||e.habitId===recordsFilterHabitId;
    });
    return filtered;
  }
  function getExportHabits(exportEntries){
    var used={};
    for(var i=0;i<exportEntries.length;i++)used[exportEntries[i].habitId]=true;
    return habits.filter(function(h){return used[h.id]});
  }
  function downloadBlob(blob,filename,message){
    var url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download=filename;document.body.appendChild(link);link.click();link.remove();
    setTimeout(function(){URL.revokeObjectURL(url)},0);
    showToast(message);
  }
  function exportData(){
    var exportEntries=getExportEntries(),exportHabits=getExportHabits(exportEntries);
    var payload={
      app:'Habit Timesheet',
      version:(document.querySelector('.app-version')||{}).textContent||'',
      exportedAt:new Date().toISOString(),
      filter:recordsFilterHabitId==='*'?'Все привычки':(habits.find(function(h){return h.id===recordsFilterHabitId})||{}).name||'',
      habits:exportHabits.map(function(h){return {id:h.id,name:h.name}}),
      entries:exportEntries.map(function(e){return {id:e.id,habitId:e.habitId,date:e.date,minutes:e.minutes,note:e.note,type:e.type,color:e.color}})
    };
    var suffix=recordsFilterHabitId==='*'?'all':recordsFilterHabitId;
    downloadBlob(new Blob([JSON.stringify(payload,null,2)],{type:'application/json;charset=utf-8'}),'habit-timesheet-'+suffix+'-'+localDate()+'.json','JSON экспортирован');
  }
  function csvCell(value){
    var s=String(value==null?'':value);
    return '"'+s.replace(/"/g,'""')+'"';
  }
  function exportCsvData(){
    var exportEntries=getExportEntries(),habitMap={};
    for(var i=0;i<habits.length;i++)habitMap[habits[i].id]=habits[i];
    var rows=[['Дата','Привычка','Минуты','Тип','Цвет','Описание']];
    for(var j=0;j<exportEntries.length;j++){
      var e=exportEntries[j],type=TYPE_OPTIONS.find(function(t){return t.id===e.type});
      rows.push([e.date,habitMap[e.habitId]?habitMap[e.habitId].name:'Удаленная привычка',Math.round(Number(e.minutes)||0),type?type.label:e.type||'',e.color||'',e.note||'']);
    }
    var csv='\ufeff'+rows.map(function(row){return row.map(csvCell).join(';')}).join('\r\n');
    var suffix=recordsFilterHabitId==='*'?'all':recordsFilterHabitId;
    downloadBlob(new Blob([csv],{type:'text/csv;charset=utf-8'}),'habit-timesheet-'+suffix+'-'+localDate()+'.csv','CSV экспортирован');
  }

  function openImportDialog(){
    var select=$('importHabit');
    if(!habits.length){showToast('Сначала добавь привычку');return}
    select.innerHTML=habits.map(function(h){
      return '<option value="'+clean(h.id)+'">'+clean(h.name)+'</option>';
    }).join('');
    select.value=habits.some(function(h){return h.id===chosenHabit})?chosenHabit:habits[0].id;
    $('importHabitButtonText').textContent=(habits.find(function(h){return h.id===select.value})||habits[0]).name;
    $('importMonth').value=currentDate.slice(0,7);
    $('importText').value='';
    rememberModalFocus();
    $('dataTransfer').hidden=false;
    setTimeout(function(){$('importHabitButton').focus()},0);
  }
  function closeImportDialog(){
    $('dataTransfer').hidden=true;
    closeMenus();
    restoreModalFocus();
  }

  function parseImportDate(value,baseMonth){
    var v=String(value||'').trim(),m,base=String(baseMonth||currentDate).match(/^(\d{4})-(\d{1,2})$/),baseYear=base?+base[1]:dateObj(currentDate).getFullYear(),baseMonthIndex=base?+base[2]-1:dateObj(currentDate).getMonth();
    if(!v)return null;

    // Google Sheets serial date.
    if(/^\d{4,6}(?:\.0+)?$/.test(v)){
      var serial=Number(v);
      if(serial>20000&&serial<100000){
        var serialDate=new Date(Date.UTC(1899,11,30)+Math.floor(serial)*86400000);
        return localDate(new Date(serialDate.getUTCFullYear(),serialDate.getUTCMonth(),serialDate.getUTCDate()));
      }
    }

    // ISO date, optionally followed by a time.
    m=v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
    if(m){
      var y=+m[1],mo=+m[2],d=+m[3],isoDate=new Date(y,mo-1,d);
      return isoDate.getFullYear()===y&&isoDate.getMonth()===mo-1&&isoDate.getDate()===d?localDate(isoDate):null;
    }

    // Russian / day-first date, with optional time.
    m=v.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})(?:[\sT].*)?$/);
    if(m){
      var day=+m[1],month=+m[2],year=+m[3];if(year<100)year+=2000;
      var fullDate=new Date(year,month-1,day);
      return fullDate.getFullYear()===year&&fullDate.getMonth()===month-1&&fullDate.getDate()===day?localDate(fullDate):null;
    }

    // Dates without a year are interpreted as DD.MM or DD/MM in the selected/current year.
    m=v.match(/^(\d{1,2})[.\/](\d{1,2})$/);
    if(m){
      var dayNo=+m[1],monthNo=+m[2];
      if(dayNo>31||monthNo<1||monthNo>12)return null;
      var partialDate=new Date(baseYear,monthNo-1,dayNo);
      return partialDate.getFullYear()===baseYear&&partialDate.getMonth()===monthNo-1&&partialDate.getDate()===dayNo?localDate(partialDate):null;
    }

    // Bare day number uses the selected import month/year.
    m=v.match(/^(\d{1,2})$/);
    if(m){
      var onlyDay=+m[1];
      if(onlyDay<1||onlyDay>31)return null;
      var dayDate=new Date(baseYear,baseMonthIndex,onlyDay);
      return dayDate.getFullYear()===baseYear&&dayDate.getMonth()===baseMonthIndex&&dayDate.getDate()===onlyDay?localDate(dayDate):null;
    }

    // No locale-dependent Date.parse fallback: unknown formats are rejected.
    return null;
  }

  function parseSheetImport(textValue,baseMonth){
    var lines=String(textValue||'').replace(/\r/g,'').split('\n'),errors=0,merged={},skipped=0,todayKey=localDate(new Date());
    for(var i=0;i<lines.length;i++){
      var line=lines[i].trim();if(!line)continue;
      var parts=line.split('\t');
      if(parts.length<2)parts=line.split(';');
      if(parts.length<2)parts=line.split(/\s{2,}/);
      var first=parts[0]?parts[0].trim():'',second=parts[1]?parts[1].trim():'';
      if((/день|дата|date/i.test(first))&&(!second||/минут|minute|min/i.test(second)))continue;
      if(parts.length<2||!first||!second){errors++;continue}
      var date=parseImportDate(first,baseMonth);
      var numericText=second.replace(/\s/g,'').replace(/[^\d,.-]/g,'').replace(',','.');
      var minutes=Number(numericText);
      if(!date||date>todayKey||!isFinite(minutes)||minutes<=0){errors++;continue}
      var rounded=Math.round(minutes);
      if(rounded<=0){errors++;continue}
      merged[date]=(merged[date]||0)+rounded;
    }
    var dates=Object.keys(merged).sort(),rows=[];
    for(var j=0;j<dates.length;j++)rows.push({date:dates[j],minutes:merged[dates[j]]});
    return {rows:rows,errors:errors,skipped:skipped};
  }

  function persistEntriesBatch(newEntries){
    if(!newEntries.length)return true;
    localMutationEpoch++;
    if(storageMode==='indexeddb'){
      var batch=cloneData(newEntries);
      queueIDBWrite(function(){
        return new Promise(function(resolve,reject){
          var tx=db.transaction(IDB_ENTRIES,'readwrite'),store=tx.objectStore(IDB_ENTRIES);
          for(var i=0;i<batch.length;i++)store.put(batch[i]);
          tx.oncomplete=function(){resolve()};
          tx.onerror=function(){reject(tx.error||new Error('IndexedDB batch write failed'))};
          tx.onabort=function(){reject(tx.error||new Error('IndexedDB batch write aborted'))};
        });
      });
      backupToLocalStorage();
      scheduleLocalBackup();
      return true;
    }
    return backupToLocalStorage();
  }

  function importFromSheet(){
    var parsed=parseSheetImport($('importText').value,$('importMonth').value);
    if(!parsed.rows.length){showToast('Не нашёл корректных строк для импорта');return}

    var selectedId=$('importHabit').value;
    var habit=habits.find(function(h){return h.id===selectedId});
    if(!habit){showToast('Выбери привычку');return}
    if(!confirm('Импортировать '+parsed.rows.length+' '+(parsed.rows.length===1?'строку':'строк')+' в «'+habit.name+'»?'))return;

    var preset=presetForHabit(habit.name)||{},existing={};
    for(var ei=0;ei<entries.length;ei++){
      var ex=entries[ei];
      if(ex.habitId===habit.id&&ex.note==='Импорт из Google Таблиц')existing[ex.date+'|'+Number(ex.minutes)]=true;
    }
    var skippedDuplicates=0,newEntries=[];
    for(var ri=0;ri<parsed.rows.length;ri++){
      var row=parsed.rows[ri],dupKey=row.date+'|'+Number(row.minutes);
      if(existing[dupKey]){skippedDuplicates++;continue}
      existing[dupKey]=true;
      newEntries.push({id:uid(),habitId:habit.id,date:row.date,minutes:row.minutes,note:'Импорт из Google Таблиц',type:preset.type||'active',color:preset.color||'blue'});
    }
    if(!newEntries.length){
      showToast('Все строки уже были импортированы');
      return;
    }

    entries=entries.concat(newEntries);
    if(!persistEntriesBatch(newEntries)){
      entries.splice(entries.length-newEntries.length,newEntries.length);
      showToast('Не удалось сохранить импорт');return;
    }
    invalidateDataCaches();
    closeImportDialog();
    renderActiveView();
    var resultNote=parsed.errors?'. Ошибок строк: '+parsed.errors:'';
    if(skippedDuplicates)resultNote+=' Уже были загружены: '+skippedDuplicates;
    showToast('Импортировано '+newEntries.length+' '+(newEntries.length===1?'запись':'записей')+resultNote);
  }
  function addHabit(){
    var name=prompt('Название привычки');
    if(!name||!name.trim())return;
    var habit={id:uid(),name:name.trim(),goal:30,color:'blue'};
    habits.push(habit);
    if(!persistHabits()){
      habits.pop();
      showToast('Не удалось сохранить привычку');
      return;
    }
    menusDirty=true;
    invalidateDataCaches();
    if(currentView==='settings')renderSettings();
    else if(currentView==='today')renderMainStats();
    else renderStats();
    showToast('Привычка добавлена');
  }

  document.getElementById('openSheet').onclick=openSheet;
  document.getElementById('exportData').onclick=exportData;
  document.getElementById('exportCsvData').onclick=exportCsvData;
  document.getElementById('importData').onclick=openImportDialog;
  document.getElementById('dataDialogClose').onclick=closeImportDialog;
  document.getElementById('dataDialogCancel').onclick=closeImportDialog;
  document.getElementById('dataImportConfirm').onclick=importFromSheet;
  document.getElementById('dataTransfer').addEventListener('click',function(e){if(e.target===this)closeImportDialog()});
  document.getElementById('closeSheet').onclick=closeSheet;
  document.getElementById('cancelSheet').onclick=closeSheet;
  document.getElementById('saveEntry').onclick=saveEntry;
  document.getElementById('addHabit').onclick=addHabit;

  document.getElementById('habitButton').onclick=function(){showMenu('habit','habitButton')};
  document.getElementById('typeButton').onclick=function(){showMenu('type','typeButton')};
  document.getElementById('colorButton').onclick=function(){showMenu('color','colorButton')};

  document.querySelectorAll('[data-visible-category]').forEach(function(button){
    button.onclick=function(){
      var key=button.getAttribute('data-visible-category');
      var query=key==='sport'?'спорт':key==='accounting'?'бухгалтер':key==='reading'?'чтени':key==='speech'?'дикци':'';
      var habit=habits.find(function(h){return (h.name||'').toLowerCase().indexOf(query)>=0});
      var preset=presetForHabit(habit?habit.name:'')||{};
      var fallbackType=key==='sport'?'sport':key==='reading'?'reading':'active';
      var fallbackColor=key==='sport'?'green':key==='reading'?'yellow':key==='speech'?'purple':'blue';
      applySelection(habit?habit.id:chosenHabit,preset.type||fallbackType,preset.color||fallbackColor);
      closeMenus();
    };
  });

  document.getElementById('menuPopover').onclick=function(e){
    var recordAction=e.target.closest('[data-record-action]');
    if(recordAction){
      var recordEntryId=recordAction.getAttribute('data-record-entry')||'';
      var action=recordAction.getAttribute('data-record-action')||'';
      closeMenus();
      if(action==='edit'){openSheetForEntry(recordEntryId);return}
      if(action==='delete'){deleteHistoryEntry(recordEntryId);return}
      return;
    }
    var importHabitOption=e.target.closest('[data-import-habit-option]');
    if(importHabitOption){
      var importId=importHabitOption.getAttribute('data-import-habit-option')||'';
      $('importHabit').value=importId;
      var importHabit=habits.find(function(h){return h.id===importId});
      $('importHabitButtonText').textContent=importHabit?importHabit.name:'Выбрать привычку';
      closeMenus();
      return;
    }
    var recordsHabitOption=e.target.closest('[data-records-habit-option]');
    if(recordsHabitOption){
      recordsFilterHabitId=recordsHabitOption.getAttribute('data-records-habit-option')||'*';
      saveUIState();
      var recordsFilterHabit=habits.find(function(h){return h.id===recordsFilterHabitId});
      $('recordsHabitFilterButtonText').textContent=recordsFilterHabit?recordsFilterHabit.name:'Все привычки';
      selectedEntryIds={};
      entryRenderLimit=60;
      closeMenus();
      renderSettings();
      return;
    }
    var calendarHabitOption=e.target.closest('[data-calendar-habit-option]');
    if(calendarHabitOption){
      calendarFilterHabitId=calendarHabitOption.getAttribute('data-calendar-habit-option')||'*';
      saveUIState();
      $('calendarFilterButtonText').textContent=calendarFilterHabitId==='*'?'Все привычки':((habits.find(function(h){return h.id===calendarFilterHabitId})||{}).name||'Все привычки');
      closeMenus();
      renderCalendarView();
      return;
    }
    var habitOption=e.target.closest('[data-habit-option]');
    if(habitOption){
      var id=habitOption.getAttribute('data-habit-option');
      var h=habits.find(function(x){return x.id===id});
      var preset=presetForHabit(h?h.name:'')||{};
      applySelection(id,preset.type||chosenType,preset.color||chosenColor);
      closeMenus();
      return;
    }

    var typeOption=e.target.closest('[data-type-option]');
    if(typeOption){
      var typeId=typeOption.getAttribute('data-type-option');
      var type=TYPE_OPTIONS.find(function(x){return x.id===typeId});
      var linked=habits.find(function(h){
        var n=(h.name||'').toLowerCase();
        return typeId==='sport'?n.indexOf('спорт')>=0:typeId==='reading'?n.indexOf('чтени')>=0:false;
      });
      applySelection(linked?linked.id:chosenHabit,typeId,type?type.defaultColor:chosenColor);
      closeMenus();
      return;
    }

    var colorOption=e.target.closest('[data-color-option]');
    if(colorOption){
      var colorId=colorOption.getAttribute('data-color-option');
      var color=COLOR_OPTIONS.find(function(x){return x.id===colorId});
      chosenColor=colorId;
      $('colorButtonText').textContent=color.label;
      $('colorDot').style.background=color.color;
      closeMenus();
    }
  };

  function positionCalendar(){
    var calendar=$('calendar'),button=$('dateButton');
    if(calendar.hidden)return;
    var rect=button.getBoundingClientRect(),edge=14,gap=8,width=Math.min(360,window.innerWidth-edge*2);
    var below=window.innerHeight-rect.bottom-gap-edge,above=rect.top-gap-edge;
    var openBelow=below>=230||below>=above;
    var maxHeight=Math.min(390,Math.max(230,openBelow?below:above));
    var top=openBelow?rect.bottom+gap:Math.max(edge,rect.top-gap-maxHeight);
    var left=Math.min(Math.max(edge,rect.left),window.innerWidth-edge-width);
    calendar.style.left=Math.round(left)+'px';
    calendar.style.top=Math.round(top)+'px';
    calendar.style.width=Math.round(width)+'px';
    calendar.style.maxHeight=Math.round(maxHeight)+'px';
  }

  document.getElementById('dateButton').onclick=function(){
    var willOpen=$('calendar').hidden;
    closeMenus();
    if(willOpen){
      $('calendar').hidden=false;
      renderCalendar();
      positionCalendar();
    }else $('calendar').hidden=true;
  };

  document.getElementById('calendar').onclick=function(e){
    var prev=e.target.closest('[data-cal-prev]');
    var next=e.target.closest('[data-cal-next]');
    var date=e.target.closest('[data-cal-date]');
    if(prev){
      var d=dateObj(calendarDate);d.setDate(1);d.setMonth(d.getMonth()-1);calendarDate=localDate(d);renderCalendar();return;
    }
    if(next){
      var d2=dateObj(calendarDate);d2.setDate(1);d2.setMonth(d2.getMonth()+1);calendarDate=localDate(d2);renderCalendar();return;
    }
    if(date){
      calendarDate=date.getAttribute('data-cal-date');
      $('dateButtonText').textContent=formatFullDate(calendarDate);
      $('calendar').hidden=true;
    }
  };

  document.getElementById('calendarPrevMonth').onclick=function(){
    var d=dateObj(calendarViewDate);d.setDate(1);d.setMonth(d.getMonth()-1);calendarViewDate=localDate(d);saveUIState();renderCalendarView();
  };
  document.getElementById('calendarNextMonth').onclick=function(){
    var d=dateObj(calendarViewDate);d.setDate(1);d.setMonth(d.getMonth()+1);calendarViewDate=localDate(d);saveUIState();renderCalendarView();
  };
  document.getElementById('calendarToday').onclick=function(){calendarViewDate=localDate(new Date());saveUIState();renderCalendarView();};
  document.getElementById('calendarFilterButton').onclick=function(){showCalendarFilterMenu();};
  document.getElementById('recordsHabitFilterButton').onclick=function(){showRecordsHabitFilterMenu();};
  document.getElementById('importHabitButton').onclick=function(){showImportHabitMenu();};

  document.getElementById('sheet').addEventListener('click',function(e){
    if(e.target===this)closeSheet();
  });

  function repositionOpenMenu(){
    if(!activeMenuKind)return;
    var buttonId=activeMenuKind==='habit'?'habitButton':activeMenuKind==='type'?'typeButton':activeMenuKind==='color'?'colorButton':activeMenuKind==='calendarHabit'?'calendarFilterButton':activeMenuKind==='recordsHabit'?'recordsHabitFilterButton':'calendarFilterButton';
    var button=$(buttonId);
    if(button)positionMenu(button);
  }

  window.addEventListener('resize',function(){
    repositionOpenMenu();
    positionCalendar();
  },{passive:true});
  window.addEventListener('scroll',function(){
    clearChartHover();
    repositionOpenMenu();
    positionCalendar();
  },{passive:true,capture:true});

  function getMenuOptions(){
    var menu=$('menuPopover');
    return menu&&menu.classList.contains('active')?Array.prototype.slice.call(menu.querySelectorAll('.option')):[];
  }
  function moveMenuFocus(delta){
    var options=getMenuOptions();if(!options.length)return;
    var current=document.activeElement,idx=options.indexOf(current);
    if(idx<0){
      var selected=options.find(function(o){return o.classList.contains('selected')});
      idx=selected?options.indexOf(selected):0;
    }
    idx=(idx+delta+options.length)%options.length;
    options[idx].focus();
  }
  function focusMenuEdge(first){
    var options=getMenuOptions();if(options.length)(first?options[0]:options[options.length-1]).focus();
  }
  function modalFocusable(dialog){
    return Array.prototype.slice.call(dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[href],[tabindex]:not([tabindex="-1"])')).filter(function(el){
      return el.offsetParent!==null&&!el.closest('.sr-only');
    });
  }
  var lastModalFocus=null;
  function rememberModalFocus(){
    lastModalFocus=document.activeElement;
  }
  function trapModalFocus(e,dialog){
    if(!dialog||dialog.hidden)return false;
    var focusables=modalFocusable(dialog);
    if(!focusables.length||e.key!=='Tab')return false;
    var first=focusables[0],last=focusables[focusables.length-1];
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();return true}
    if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();return true}
    return false;
  }
  function restoreModalFocus(){
    if(lastModalFocus&&document.contains(lastModalFocus)&&typeof lastModalFocus.focus==='function')lastModalFocus.focus();
    lastModalFocus=null;
  }
  function activeModalDialog(){
    return !$('dataTransfer').hidden?$('dataTransfer').querySelector('.data-dialog'):(!$('sheet').hidden?$('sheet'):null);
  }
  function activeMenuTrigger(){
    var buttonId=activeMenuKind==='habit'?'habitButton':activeMenuKind==='type'?'typeButton':activeMenuKind==='color'?'colorButton':activeMenuKind==='calendarHabit'?'calendarFilterButton':activeMenuKind==='recordsHabit'?'recordsHabitFilterButton':activeMenuKind==='importHabit'?'importHabitButton':'recordActionButton';
    return $(buttonId);
  }
  function moveTabFromMenu(e){
    var dialog=activeModalDialog(),trigger=activeMenuKind==='recordActions'?activeRecordActionButton:activeMenuTrigger();
    if(!trigger)return false;
    if(!dialog){
      if(e.key==='Tab'){e.preventDefault();closeMenus();trigger.focus();return true}
      return false;
    }
    var focusables=modalFocusable(dialog),idx=focusables.indexOf(trigger);
    if(idx<0)return false;
    e.preventDefault();
    closeMenus();
    var nextIndex=e.shiftKey?idx-1:idx+1;
    if(nextIndex<0)nextIndex=focusables.length-1;
    if(nextIndex>=focusables.length)nextIndex=0;
    focusables[nextIndex].focus();
    return true;
  }
  document.addEventListener('keydown',function(e){
    if(e.key==='Escape'&&activeMenuKind){closeMenus();return}
    if(activeMenuKind){
      if(e.key==='Tab'&&moveTabFromMenu(e))return;
      if(e.key==='ArrowDown'){e.preventDefault();moveMenuFocus(1);return}
      if(e.key==='ArrowUp'){e.preventDefault();moveMenuFocus(-1);return}
      if(e.key==='Home'){e.preventDefault();focusMenuEdge(true);return}
      if(e.key==='End'){e.preventDefault();focusMenuEdge(false);return}
      if(e.key==='Enter'){
        var focused=document.activeElement;
        if(focused&&focused.classList.contains('option')){e.preventDefault();focused.click();return}
      }
    }
    if(e.key==='Escape'&&!$('dataTransfer').hidden){closeImportDialog();return}
    if(e.key==='Escape'&&!$('sheet').hidden){closeSheet();return}
    var activeDialog=activeModalDialog();
    if(activeDialog&&trapModalFocus(e,activeDialog))return;
    if((e.ctrlKey||e.metaKey)&&e.key==='Enter'&&!$('sheet').hidden)saveEntry();
  });

  document.addEventListener('change',function(e){
    var check=e.target.closest('[data-entry-check]');
    if(!check||!entrySelectionMode)return;
    var id=check.getAttribute('data-entry-check');
    if(check.checked)selectedEntryIds[id]=true;
    else delete selectedEntryIds[id];
    renderSettings();
  });

  document.getElementById('toggleEntrySelection').onclick=function(){
    entrySelectionMode=!entrySelectionMode;
    if(!entrySelectionMode)selectedEntryIds={};
    renderSettings();
  };

  document.getElementById('selectAllEntries').onclick=function(){
    if(!entrySelectionMode)return;
    selectedEntryIds={};
    for(var i=0;i<entries.length;i++){
      if(recordsFilterHabitId==='*'||entries[i].habitId===recordsFilterHabitId)selectedEntryIds[entries[i].id]=true;
    }
    renderSettings();
  };
  document.getElementById('clearEntrySelection').onclick=function(){
    if(!entrySelectionMode)return;
    selectedEntryIds={};
    renderSettings();
  };
  document.getElementById('deleteSelectedEntries').onclick=function(){
    var ids=Object.keys(selectedEntryIds).filter(function(id){return selectedEntryIds[id]&&entries.some(function(e){return e.id===id})});
    if(!ids.length)return;
    if(!confirm('Удалить выбранные записи ('+ids.length+')?'))return;
    var removed=[];
    entries=entries.filter(function(e){
      if(ids.indexOf(e.id)>=0){removed.push(e);return false}
      return true;
    });
    var removedForUndo=cloneData(removed);
    if(!deleteEntriesFromStorage(ids)){
      entries=entries.concat(removed);
      showToast('Не удалось удалить выбранные записи');
      return;
    }
    selectedEntryIds={};
    if(!entries.length)entrySelectionMode=false;
    invalidateDataCaches();
    renderSettings();
    scheduleActiveRender();
    var undoEpochBatch=localMutationEpoch;
    showUndoToast('Удалено записей: '+ids.length,function(){
      if(localMutationEpoch!==undoEpochBatch){showToast('Отмена недоступна: данные уже изменились');return}
      entries=entries.concat(removedForUndo);
      if(!persistEntries()){showToast('Не удалось отменить удаление');return}
      selectedEntryIds={};
      invalidateDataCaches();
      renderSettings();
      scheduleActiveRender();
      showToast('Удаление отменено');
    });
  };

  function deleteHistoryEntry(entryId){
    var entryIndex=-1;
    for(var ei=0;ei<entries.length;ei++){
      if(entries[ei].id===entryId){entryIndex=ei;break}
    }
    if(entryIndex<0)return;
    var removedEntry=entries[entryIndex];
    var entryHabit=habits.find(function(h){return h.id===removedEntry.habitId});
    if(!confirm('Удалить запись «'+(entryHabit?entryHabit.name:'')+'» за '+formatFullDate(removedEntry.date||currentDate)+' ('+fmt(removedEntry.minutes)+')?'))return;
    entries.splice(entryIndex,1);
    var removedForUndoSingle=cloneData([removedEntry])[0];
    if(!deleteEntryFromStorage(removedEntry.id)){
      entries.splice(entryIndex,0,removedEntry);
      showToast('Не удалось удалить запись');
      return;
    }
    delete selectedEntryIds[removedEntry.id];
    invalidateDataCaches();
    renderSettings();
    scheduleActiveRender();
    var undoEpochSingle=localMutationEpoch;
    showUndoToast('Запись удалена',function(){
      if(localMutationEpoch!==undoEpochSingle){showToast('Отмена недоступна: данные уже изменились');return}
      entries.splice(Math.min(entryIndex,entries.length),0,removedForUndoSingle);
      if(!persistEntries()){showToast('Не удалось отменить удаление');return}
      invalidateDataCaches();
      renderSettings();
      scheduleActiveRender();
      showToast('Удаление отменено');
    });
  }

  document.addEventListener('click',function(e){
    var recordMenuButton=e.target.closest('[data-record-menu]');
    if(recordMenuButton){
      showRecordActionsMenu(recordMenuButton.getAttribute('data-record-menu')||'',recordMenuButton);
      return;
    }
    var calendarCell=e.target.closest('[data-calendar-date]');
    if(calendarCell&&currentView==='calendar'){
      currentDate=calendarCell.getAttribute('data-calendar-date');
      calendarViewDate=currentDate;
      calendarDateSelectionActive=true;
      saveUIState();
      currentView='today';
      renderActiveView();
      return;
    }
    if(activeMenuKind&&!e.target.closest('#menuPopover')&&!e.target.closest('.custom-select')&&!e.target.closest('#calendarFilterButton')&&!e.target.closest('#recordsHabitFilterButton')&&!e.target.closest('[data-record-menu]'))closeMenus();
    if(!$('calendar').hidden&&!e.target.closest('#calendar')&&!e.target.closest('#dateButton'))$('calendar').hidden=true;

    var more=e.target.closest('#showMoreEntries');
    if(more){
      entryRenderLimit+=60;
      renderSettings();
      return;
    }

    var editEntry=e.target.closest('[data-edit-entry]');
    if(editEntry){
      openSheetForEntry(editEntry.getAttribute('data-edit-entry'));
      return;
    }

    var removeEntry=e.target.closest('[data-remove-entry]');
    if(removeEntry){
      deleteHistoryEntry(removeEntry.getAttribute('data-remove-entry')||'');
      return;
    }

    var remove=e.target.closest('[data-remove-habit]');
    if(remove){
      var id=remove.getAttribute('data-remove-habit');
      var habit=habits.find(function(h){return h.id===id});
      if(habit&&confirm('Удалить «'+habit.name+'» и все записи этой привычки?')){
        var oldHabits=habits.slice();
        var oldEntries=entries.slice();
        habits=habits.filter(function(h){return h.id!==id});
        entries=entries.filter(function(x){return x.habitId!==id});
        for(var sid in selectedEntryIds)if(!entries.some(function(x){return x.id===sid}))delete selectedEntryIds[sid];
        if(!deleteHabitFromStorage(id)){
          habits=oldHabits;
          entries=oldEntries;
          showToast('Не удалось удалить привычку');
          return;
        }
        menusDirty=true;
        resetInvalidFilters();
        entryRenderLimit=Math.min(entryRenderLimit,Math.max(60,entries.length));
        invalidateDataCaches();
        scheduleActiveRender();
        var undoEpochHabit=localMutationEpoch;
        showUndoToast('Привычка удалена',function(){
          if(localMutationEpoch!==undoEpochHabit){showToast('Отмена недоступна: данные уже изменились');return}
          habits=oldHabits;
          entries=oldEntries;
          if(!persistAll()){showToast('Не удалось отменить удаление');return}
          menusDirty=true;
          resetInvalidFilters();
          invalidateDataCaches();
          renderActiveView();
          showToast('Удаление отменено');
        });
      }
    }
  });

  domCache.navs.forEach(function(button){
    button.onclick=function(){
      var nextView=button.getAttribute('data-view');
      if(nextView===currentView)return;
      if(calendarDateSelectionActive&&nextView!=='today'){
        currentDate=localDate(new Date());
        calendarViewDate=currentDate;
        calendarDateSelectionActive=false;
        saveUIState();
      }
      currentView=nextView;
      renderActiveView();
    };
  });

  calendarModule=window.HabitTimesheetCalendar.create({
    $:$,
    getHabits:function(){return habits},
    getStats:getStats,
    getFilterHabitId:function(){return calendarFilterHabitId},
    getCalendarViewDate:function(){return calendarViewDate},
    fmt:fmt,
    dateObj:dateObj,
    localDate:localDate,
    formatFullDate:formatFullDate,
    clean:clean,
    getPresetForHabit:presetForHabit,
    colorById:COLOR_BY_ID
  });
  calendarModule.initHover();

  render();

  window.__APP_READY=true;
  window.__STORAGE_READY=false;
  initIndexedDB();
})();