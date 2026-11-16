cmake_minimum_required(VERSION 3.20)
project(EmberFixedUvSpawnProbe LANGUAGES C)

if(NOT WIN32 OR NOT MSVC OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8 OR NOT MSVC_VERSION EQUAL 1944)
  message(FATAL_ERROR "The fixed spawn probe requires the selected Windows x64 MSVC toolchain.")
endif()
foreach(required EMBER_UV_SOURCE EMBER_PROBE_C EMBER_OBSERVER_C EMBER_OBSERVER_HEADER)
  if(NOT EXISTS "${${required}}")
    message(FATAL_ERROR "Provide only the verified source and fixed probe inputs.")
  endif()
endforeach()

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_MSVC_RUNTIME_LIBRARY MultiThreaded)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(LIBUV_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(LIBUV_BUILD_BENCH OFF CACHE BOOL "" FORCE)
set(LIBUV_BUILD_SHARED OFF CACHE BOOL "" FORCE)
add_subdirectory("${EMBER_UV_SOURCE}" uv)

# Keep signed upstream CMake bytes intact; replace exactly its one target definition before any SDK include.
get_target_property(ember_uv_definitions uv_a COMPILE_DEFINITIONS)
set(ember_original_definition_count 0)
foreach(definition IN LISTS ember_uv_definitions)
  if(definition STREQUAL "_WIN32_WINNT=0x0A00")
    math(EXPR ember_original_definition_count "${ember_original_definition_count} + 1")
  elseif(definition MATCHES "_WIN32_WINNT")
    message(FATAL_ERROR "The pinned libuv target has an unexpected Windows target definition.")
  endif()
endforeach()
if(NOT ember_original_definition_count EQUAL 1)
  message(FATAL_ERROR "The pinned libuv target definition changed.")
endif()
list(REMOVE_ITEM ember_uv_definitions "_WIN32_WINNT=0x0A00")
list(APPEND ember_uv_definitions "_WIN32_WINNT=0x0602" "EMBER_UV_FIXED_PROBE_OFFLINE=1")
set_property(TARGET uv_a PROPERTY COMPILE_DEFINITIONS "${ember_uv_definitions}")

# Only these two original call-site units see aliases. The observer itself calls real SDK imports.
set_property(SOURCE "${EMBER_UV_SOURCE}/src/win/pipe.c" DIRECTORY "${EMBER_UV_SOURCE}" APPEND PROPERTY
  COMPILE_OPTIONS "/FI${EMBER_OBSERVER_HEADER}")
set_property(SOURCE "${EMBER_UV_SOURCE}/src/win/pipe.c" DIRECTORY "${EMBER_UV_SOURCE}" APPEND PROPERTY
  COMPILE_DEFINITIONS "EMBER_UV_SPAWN_OBSERVE_PIPE=1")
set_property(SOURCE "${EMBER_UV_SOURCE}/src/win/process.c" DIRECTORY "${EMBER_UV_SOURCE}" APPEND PROPERTY
  COMPILE_OPTIONS "/FI${EMBER_OBSERVER_HEADER}")
set_property(SOURCE "${EMBER_UV_SOURCE}/src/win/process.c" DIRECTORY "${EMBER_UV_SOURCE}" APPEND PROPERTY
  COMPILE_DEFINITIONS "EMBER_UV_SPAWN_OBSERVE_PROCESS=1")

add_executable(ember_uv_spawn_probe "${EMBER_PROBE_C}" "${EMBER_OBSERVER_C}")
target_link_libraries(ember_uv_spawn_probe PRIVATE uv_a advapi32)
target_compile_definitions(ember_uv_spawn_probe PRIVATE _WIN32_WINNT=0x0602 EMBER_UV_FIXED_PROBE_OFFLINE=1)
target_compile_options(ember_uv_spawn_probe PRIVATE /W4 /we4013 /utf-8 /GS)
# This public-source listing is retained locally for a separate emission review, never executed or uploaded.
set_property(SOURCE "${EMBER_OBSERVER_C}" APPEND PROPERTY COMPILE_OPTIONS "/FA" "/Fa${CMAKE_BINARY_DIR}/observer.asm")
