-- Pin search_path on the two helper functions added in phase3_2_inventory (advisor: function_search_path_mutable).
alter function public._guard_stock_move() set search_path = public;
alter function public._jl(uuid, numeric, text) set search_path = public;
