function fakeBundle(){
  var message = "virtual scrolling requires setting the rowHeight";
  var rowHeightService = {};
  function adjustVirtualScrolling(model){
    var originalRowHeight = model.originalRowHeight;
    if (!model.isPageSizeCalculated){
      model.pageSize = model.pageSize || 80;
    }
    return message + originalRowHeight + rowHeightService;
  }
  return adjustVirtualScrolling;
}
