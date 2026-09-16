/**
 * 搜索薄封装
 */
const SearchHandler = {
  init() {
    return true;
  },
  open() {
    SearchUI.showSearchModal();
  }
};

if (typeof window !== 'undefined') window.SearchHandler = SearchHandler;
