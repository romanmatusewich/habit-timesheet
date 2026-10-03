/* Habit Timesheet — statistics calculations and cached derived data. */
(function(window){
  'use strict';

  function create(options){
    var getEntries=options.getEntries;
    var getHabits=options.getHabits;
    var getColorById=options.getColorById;
    var typeOptions=options.typeOptions;
    var localDate=options.localDate;
    var dateObj=options.dateObj;
    var fmt=options.fmt;
    var clean=options.clean;
    var habitColor=options.habitColor;
    var habitColorEnd=options.habitColorEnd;
    var cache=null;
    var sortedEntriesCache=null;
    var renderCache={habitBreakdownHTML:null,statsBreakdownHTML:null,habitBreakdownMax:0};

    function invalidate(){
      cache=null;
      sortedEntriesCache=null;
      renderCache.habitBreakdownHTML=null;
      renderCache.statsBreakdownHTML=null;
      renderCache.habitBreakdownMax=0;
    }

    function getStats(){
      if(cache)return cache;
      var entries=getEntries(),habits=getHabits(),colorById=getColorById();
      var byHabit={},byDate={},byDateHabit={},byDateColor={},habitColorById={},countByDate={},byType={},activeByMonth={},sportByDate={},total=0,sessionCount=0,longest=0;
      var todayKey=localDate(new Date());
      for(var i=0;i<entries.length;i++){
        var e=entries[i],minutes=Number(e.minutes)||0;
        if(!e.date||e.date>todayKey||minutes<=0)continue;
        total+=minutes;
        sessionCount++;
        if(minutes>longest)longest=minutes;
        byDate[e.date]=(byDate[e.date]||0)+minutes;
        countByDate[e.date]=(countByDate[e.date]||0)+1;
        byHabit[e.habitId]=(byHabit[e.habitId]||0)+minutes;
        if(!byDateHabit[e.date])byDateHabit[e.date]={};
        byDateHabit[e.date][e.habitId]=(byDateHabit[e.date][e.habitId]||0)+minutes;
        var entryColor=e.color||'yellow';
        if(!byDateColor[e.date])byDateColor[e.date]={};
        byDateColor[e.date][entryColor]=(byDateColor[e.date][entryColor]||0)+minutes;
        if(colorById[entryColor]&&e.habitId)habitColorById[e.habitId]=entryColor;
        byType[e.type||'active']=(byType[e.type||'active']||0)+minutes;
        if(e.habitId==='sport'){
          if(!sportByDate[e.date])sportByDate[e.date]=[];
          sportByDate[e.date].push({sportType:e.sportType||'strength',kilometers:Math.max(0,Number(e.kilometers)||0),avgSpeed:Math.max(0,Number(e.avgSpeed)||0),minutes:minutes});
        }
      }

      var activeDays=Object.keys(byDate).length;
      var dateKeys=Object.keys(byDate);
      for(var di=0;di<dateKeys.length;di++){
        var monthKey=dateKeys[di].slice(0,7);
        activeByMonth[monthKey]=(activeByMonth[monthKey]||0)+1;
      }

      var cutoffObj=dateObj(todayKey);cutoffObj.setDate(cutoffObj.getDate()-29);
      var cutoffKey=localDate(cutoffObj);
      var last30Total=0,last30Sessions=0,last30ActiveDays=0,bestDayDate='',bestDayTotal=0;
      for(var dki=0;dki<dateKeys.length;dki++){
        var dk=dateKeys[dki],dayValue=byDate[dk]||0;
        if(dk>=cutoffKey&&dk<=todayKey){
          last30Total+=dayValue;
          last30Sessions+=countByDate[dk]||0;
          last30ActiveDays++;
        }
        if(dayValue>bestDayTotal){bestDayTotal=dayValue;bestDayDate=dk}
      }

      var habitTotals=habits.map(function(h){
        return {habit:h,total:byHabit[h.id]||0};
      }).sort(function(a,b){return b.total-a.total});

      cache={
        byHabit:byHabit,
        byDate:byDate,
        byDateHabit:byDateHabit,
        byDateColor:byDateColor,
        habitColorById:habitColorById,
        countByDate:countByDate,
        byType:byType,
        sportByDate:sportByDate,
        activeByMonth:activeByMonth,
        habitTotals:habitTotals,
        total:total,
        sessionCount:sessionCount,
        activeDays:activeDays,
        longest:longest,
        last30Total:last30Total,
        last30Sessions:last30Sessions,
        last30ActiveDays:last30ActiveDays,
        bestDayDate:bestDayDate,
        bestDayTotal:bestDayTotal
      };
      return cache;
    }

    function getSortedEntries(){
      if(sortedEntriesCache)return sortedEntriesCache;
      sortedEntriesCache=getEntries().slice().sort(function(a,b){
        var dateCompare=String(b.date||'').localeCompare(String(a.date||''));
        if(dateCompare)return dateCompare;
        return String(b.id||'').localeCompare(String(a.id||''));
      });
      return sortedEntriesCache;
    }

    function weekDates(end){
      var base=dateObj(end),dow=(base.getDay()+6)%7;
      base.setDate(base.getDate()-dow);
      var out=[];
      for(var i=0;i<7;i++){var d=new Date(base);d.setDate(base.getDate()+i);out.push(localDate(d))}
      return out;
    }

    function allTotals(){
      return getStats().habitTotals.slice();
    }

    function weeklyStatsTotals(){
      var stats=getStats(),today=dateObj(localDate(new Date())),out=[];
      for(var w=7;w>=0;w--){
        var end=new Date(today);end.setDate(today.getDate()-w*7);
        var start=new Date(end);start.setDate(end.getDate()-6);
        var total=0;
        for(var d=new Date(start);d<=end;d.setDate(d.getDate()+1))total+=stats.byDate[localDate(d)]||0;
        out.push({start:localDate(start),end:localDate(end),total:total});
      }
      return out;
    }

    function typeDonutData(byType,total){
      var colorById=getColorById();
      var parts=typeOptions.map(function(t){
        return {label:t.label,total:byType[t.id]||0,color:t.chartColor||colorById[t.defaultColor]||'#6e73ff'};
      }).filter(function(x){return x.total>0});
      var stops=[],cursor=0;
      for(var i=0;i<parts.length;i++){
        var end=cursor+(parts[i].total/Math.max(total,1))*360;
        stops.push(parts[i].color+' '+cursor.toFixed(1)+'deg '+end.toFixed(1)+'deg');
        cursor=end;
      }
      return {parts:parts,gradient:stops.length?'conic-gradient('+stops.join(',')+')':'conic-gradient(#d7dbe5 0deg 360deg)'};
    }

    function getHabitBreakdownHTML(totals){
      if(renderCache.habitBreakdownHTML!==null)return renderCache.habitBreakdownHTML;
      var max=60;
      for(var i=0;i<totals.length;i++)if(totals[i].total>max)max=totals[i].total;
      renderCache.habitBreakdownMax=max;
      renderCache.habitBreakdownHTML=totals.map(function(x){
        var color=habitColor(x.habit),end=habitColorEnd(color),pct=Math.round(x.total/max*100);
        return '<div class="break-row"><div class="break-left"><div class="break-name"><span class="color-dot" style="background:'+color+';margin-right:7px;vertical-align:1px"></span>'+clean(x.habit.name)+'</div><div class="mini-progress"><i style="--row-color:'+color+';--row-color-end:'+end+';width:'+pct+'%"></i></div></div><div class="break-value">'+fmt(x.total)+'</div></div>';
      }).join('')||'<div class="break-row"><div class="break-name">Нет привычек</div><div class="break-value">—</div></div>';
      return renderCache.habitBreakdownHTML;
    }

    function getStatsBreakdownHTML(totals){
      if(renderCache.statsBreakdownHTML!==null)return renderCache.statsBreakdownHTML;
      var grand=totals.reduce(function(sum,x){return sum+x.total},0);
      renderCache.statsBreakdownHTML=totals.map(function(x){
        var color=habitColor(x.habit),end=habitColorEnd(color),pct=grand?Math.round(x.total/grand*100):0,bar=x.total?Math.max(4,pct):0;
        return '<div class="habit-stats-row"><div class="habit-stats-main"><div class="habit-stats-name"><span class="color-dot" style="background:'+color+'"></span><span>'+clean(x.habit.name)+'</span></div><div class="habit-stats-bar"><i style="--row-color:'+color+';--row-color-end:'+end+';width:'+bar+'%"></i></div></div><div class="habit-stats-time">'+fmt(x.total)+'</div><div class="habit-stats-share">'+pct+'%</div></div>';
      }).join('')||'<div class="empty">Нет данных.</div>';
      return renderCache.statsBreakdownHTML;
    }

    return {
      getStats:getStats,
      getSortedEntries:getSortedEntries,
      weekDates:weekDates,
      allTotals:allTotals,
      weeklyStatsTotals:weeklyStatsTotals,
      typeDonutData:typeDonutData,
      getHabitBreakdownHTML:getHabitBreakdownHTML,
      getStatsBreakdownHTML:getStatsBreakdownHTML,
      invalidate:invalidate
    };
  }

  window.HabitTimesheetStatistics={create:create};
})(window);
