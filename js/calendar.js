/* Habit Timesheet — monthly calendar view and hover interactions. */
(function(window){
  'use strict';

  function create(options){
    var $=options.$;
    var getHabits=options.getHabits;
    var getStats=options.getStats;
    var getFilterHabitId=options.getFilterHabitId;
    var getCalendarViewDate=options.getCalendarViewDate;
    var fmt=options.fmt;
    var dateObj=options.dateObj;
    var localDate=options.localDate;
    var formatFullDate=options.formatFullDate;
    var clean=options.clean;
    var getPresetForHabit=options.getPresetForHabit;
    var colorById=options.colorById;

    function habitColorId(habit){
      if(habit&&habit.color&&colorById[habit.color])return habit.color;
      var preset=getPresetForHabit(habit?habit.name:'')||{};
      return preset.color&&colorById[preset.color]?preset.color:'blue';
    }

    function tooltipColorText(colorId){
      return colorId==='yellow'?'#2f2b1a':'#fff';
    }

    function monthLabel(date){
      var d=dateObj(date),names=['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
      return names[d.getMonth()]+' '+d.getFullYear();
    }

    function calendarTooltip(date,stats,filteredHabitId){
      var total=stats.byDate[date]||0,habitTotals=stats.byDateHabit[date]||{},habitMap={},habits=getHabits();
      for(var i=0;i<habits.length;i++)habitMap[habits[i].id]=habits[i];
      var ids=Object.keys(habitTotals).filter(function(id){
        return filteredHabitId==='*'||id===filteredHabitId;
      }).sort(function(a,b){return habitTotals[b]-habitTotals[a]});
      var visibleTotal=filteredHabitId==='*'?total:(habitTotals[filteredHabitId]||0);
      var html='<div class="tooltip-head">'+clean(formatFullDate(date))+'<span class="tooltip-head-total">'+fmt(visibleTotal)+'</span></div>';
      if(!ids.length)return html+'<div class="tooltip-empty">Нет записей</div>';
      html+='<div class="tooltip-list">';
      for(var j=0;j<ids.length;j++){
        var id=ids[j],habit=habitMap[id],minutes=habitTotals[id]||0,colorId=habit?habitColorId(habit):'blue';
        html+='<div class="tooltip-row"><span class="tooltip-habit" title="'+clean(habit?habit.name:'Удаленная привычка')+'">'+clean(habit?habit.name:'Удаленная привычка')+'</span><span class="tooltip-minutes" style="background:'+colorById[colorId]+';color:'+tooltipColorText(colorId)+'">'+Math.round(minutes)+'</span></div>';
      }
      html+='</div>';
      return html;
    }

    function calendarDateData(date,stats){
      var filteredHabitId=getFilterHabitId(),habits=getHabits();
      if(filteredHabitId==='*')return {total:stats.byDate[date]||0,colorTotals:stats.byDateColor[date]||{}};
      var total=(stats.byDateHabit[date]&&stats.byDateHabit[date][filteredHabitId])||0;
      var habit=habits.find(function(h){return h.id===filteredHabitId}),colorId=habit&&habit.defaultColor?habit.defaultColor:'blue';
      return {total:total,colorTotals:total?{[colorId]:total}:{}};
    }

    function calendarTooltipFiltered(date,stats){
      var filteredHabitId=getFilterHabitId(),data=calendarDateData(date,stats),lines=[formatFullDate(date)+' · '+fmt(data.total)];
      if(filteredHabitId==='*')return calendarTooltip(date,stats);
      var habit=getHabits().find(function(h){return h.id===filteredHabitId});
      if(habit&&data.total)lines.push(habit.name+': '+fmt(data.total));
      return lines.join('\\n');
    }

    function positionCalendarHoverNote(cell){
      var note=$('calendarHoverNote');if(!note||!cell)return;
      if(note.parentNode!==cell)cell.appendChild(note);
      var rect=cell.getBoundingClientRect(),pad=12;
      note.classList.remove('below');
      note.style.setProperty('--tip-shift','0px');
      note.classList.add('active');
      var nr=note.getBoundingClientRect();
      var center=rect.left+rect.width/2,minCenter=pad+nr.width/2,maxCenter=window.innerWidth-pad-nr.width/2;
      var shift=Math.max(-rect.width/2,Math.min(rect.width/2,Math.max(minCenter,Math.min(maxCenter,center))-center));
      note.style.setProperty('--tip-shift',Math.round(shift)+'px');
      if(rect.top<nr.height+24)note.classList.add('below');
    }

    function renderCalendarView(){
      var note=$('calendarHoverNote'),calendarViewDate=getCalendarViewDate(),calendarFilterHabitId=getFilterHabitId(),habits=getHabits();
      note&&note.classList.remove('active','below');
      var d=dateObj(calendarViewDate),year=d.getFullYear(),month=d.getMonth();
      var first=new Date(year,month,1),firstDay=(first.getDay()+6)%7,daysInMonth=new Date(year,month+1,0).getDate(),prevDays=new Date(year,month,0).getDate();
      var stats=getStats(),names=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'],html='';
      var selectedHabit=habits.find(function(h){return h.id===calendarFilterHabitId});
      $('calendarFilterButtonText').textContent=selectedHabit?selectedHabit.name:'Все привычки';
      $('calendarRangeLabel').textContent=monthLabel(calendarViewDate);
      for(var w=0;w<7;w++)html+='<div class="calendar-weekday">'+names[w]+'</div>';

      var today=localDate(new Date());
      for(var i=0;i<42;i++){
        var day,muted,date;
        if(i<firstDay){day=prevDays-firstDay+i+1;muted=true;date=localDate(new Date(year,month-1,day))}
        else if(i<firstDay+daysInMonth){day=i-firstDay+1;muted=false;date=localDate(new Date(year,month,day))}
        else{day=i-firstDay-daysInMonth+1;muted=true;date=localDate(new Date(year,month+1,day))}
        var data=calendarDateData(date,stats),total=data.total,colorTotals=data.colorTotals;
        var colors=Object.keys(colorTotals).filter(function(id){return colorTotals[id]>0&&colorById[id]}).sort(function(a,b){return colorTotals[b]-colorTotals[a]});
        var stack='';
        for(var c=0;c<colors.length&&c<5;c++){
          var colorId=colors[c],ratio=colorTotals[colorId]/Math.max(total,1);
          stack+='<span class="calendar-color-segment" style="background:'+colorById[colorId]+';flex:'+Math.max(.15,ratio)+'"></span>';
        }
        var cls='calendar-cell'+(muted?' muted':'')+(total?' has-data':'')+(date===today?' today':'');
        html+='<div class="'+cls+'" data-calendar-date="'+date+'"><div class="calendar-day-number">'+day+'</div><div class="calendar-day-total">'+(total?fmt(total):'')+'</div><div class="calendar-color-stack">'+stack+'</div></div>';
      }
      $('monthCalendar').innerHTML=html;
      if(note){
        $('monthCalendar').appendChild(note);
        note.classList.remove('active','below');
      }
    }

    var calendarHoverCell=null,calendarHoverTimer=0;

    function initHover(){
      var root=$('monthCalendar');
      if(!root)return;
      root.addEventListener('mouseover',function(e){
        var cell=e.target.closest('[data-calendar-date]');
        if(!cell||cell===calendarHoverCell)return;
        var hoverDate=cell.getAttribute('data-calendar-date');
        if(!calendarDateData(hoverDate,getStats()).total)return;
        clearTimeout(calendarHoverTimer);
        calendarHoverCell=cell;
        calendarHoverTimer=setTimeout(function(){
          if(calendarHoverCell!==cell)return;
          $('calendarHoverNote').innerHTML=calendarTooltipFiltered(hoverDate,getStats());
          positionCalendarHoverNote(cell);
        },550);
      });
      root.addEventListener('mouseout',function(e){
        var next=e.relatedTarget&&e.relatedTarget.closest?e.relatedTarget.closest('[data-calendar-date]'):null;
        if(next===calendarHoverCell)return;
        clearTimeout(calendarHoverTimer);
        calendarHoverCell=null;
        var note=$('calendarHoverNote');
        if(note)note.classList.remove('active');
      });
    }

    return {
      renderCalendarView:renderCalendarView,
      calendarTooltip:calendarTooltip,
      initHover:initHover
    };
  }

  window.HabitTimesheetCalendar={create:create};
})(window);
